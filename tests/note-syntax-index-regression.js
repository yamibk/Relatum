'use strict';
// Real CodeMirror transactions, synthetic Markdown, and test-only counters.
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const root = path.resolve(__dirname, '..'), context = { console };
context.window = context;
vm.createContext(context);
for (const name of ['vendor/codemirror/relatum-codemirror.min.js', 'markdown-table.js', 'markdown.js']) {
  vm.runInContext(fs.readFileSync(path.join(root, 'assets', name), 'utf8'), context);
}
let source = fs.readFileSync(path.join(root, 'assets/note-live-editor.js'), 'utf8');
source = source.replace('  window.RelatumNoteLiveSyntax = {',
  '  window.syntaxTest = {scanNoteSyntaxContext, updateNoteSyntaxContext};\n  window.RelatumNoteLiveSyntax = {');
source = source.replace('function scanNoteSyntaxContext(state) {', 'function scanNoteSyntaxContext(state) { window.fullScans = (window.fullScans || 0) + 1;');
source = source.replace('    const guards = [...protectedRanges, ...inlineCode,', '    window.headingRangeObjects = inlineCode.length;\n    const guards = [...protectedRanges, ...inlineCode,');
vm.runInContext(source, context);
const CM = context.RelatumCodeMirror, api = context.syntaxTest;
const clean = value => JSON.parse(JSON.stringify(value));
const result = value => clean({ definitions: value.definitions, uses: value.uses, headings: value.headings,
  tocs: value.tocs, signature: value.semanticSignature });
let checks = 0;
function sequence(value, edits) {
  let state = CM.EditorState.create({ doc: value }), index = api.scanNoteSyntaxContext(state);
  for (const edit of edits) {
    const change = typeof edit === 'function' ? edit(state.doc.toString()) : edit;
    const transaction = state.update({ changes: change });
    index = api.updateNoteSyntaxContext(index, transaction); state = transaction.state;
    assert.deepEqual(result(index), result(api.scanNoteSyntaxContext(state)), JSON.stringify(change) + '\n' + state.doc.toString());
    checks++;
  }
}
const fence = '`'.repeat(3);
const fixture = '[TOC]\n\n# First **bold**\n\nParagraph [r], [^unknown] and [^n].\n\n'
  + '[r]: https://example.com\n\n[^n]: first\n    continued\n\n    after blank\n\n'
  + '> # Hidden\n> quote\n\n- list\n\n  ## Nested\n\n' + fence + 'md\n# Code\n[^n]\n' + fence
  + '\n\n<!--\n# Comment\n-->\n\n$$\n# Formula\n$$\n\n## Last\n';
sequence(fixture, [
  value => ({ from: value.indexOf('First') + 3, insert: 'x' }),
  value => ({ from: value.indexOf('Paragraph') + 5, insert: '[' }),
  value => ({ from: value.indexOf('[^n].'), to: value.indexOf('[^n].') + 4, insert: '[^unknown]' }),
  value => ({ from: value.length, insert: '\n[^unknown]: newly resolved\n\n[r]: /second.md\n' }),
  value => ({ from: value.indexOf('continued'), to: value.indexOf('continued') + 9, insert: 'edited\n\n    another line' }),
  value => ({ from: value.indexOf('[r]: '), to: value.indexOf('[r]: ') + '[r]: https://example.com'.length, insert: '' }),
  value => ({ from: value.indexOf('<!--'), to: value.indexOf('<!--') + 4, insert: '' }),
  value => ({ from: value.indexOf(fence), to: value.indexOf(fence) + 3, insert: '~~~' }),
  value => ({ from: value.length, insert: '\n~~~\n\n# Visible again\n' }),
  value => ({ from: 0, to: value.length, insert: 'plain\n\ntext' }),
  value => ({ from: value.length, insert: '\n\n[^x]: definition\n' }),
  () => ({ from: 0, insert: '[^x]\n\n[TOC]\n\n# Added\n\n' }),
]);
for (const value of [fixture, '---\ntitle: [^x]\n---\n\n[TOC]\n\n# Root\n\n[^x]: Def\n',
  '[TOC]\n\nA multiline\nheading\n---\n\n# End', '[r]: /a.md\n\n[r]\n\n\\[\n[^x]\n\\]\n\n[^x]: x',
  '[TOC]\n\n# Before\n\nplain\n\n## After\n']) {
  let state = CM.EditorState.create({ doc: value }), index = api.scanNoteSyntaxContext(state), seed = 2753;
  const pieces = ['x', '[', ']', '#', '$', '`', '~', '\n', ' ', '\n\n', '<!--', '-->', '%%', '> ', '- ', '    ', '[^x]', '[^x]: x', '[r]: /b.md', '[TOC]', '$$', '\\[', '\\]', '😀'];
  const random = max => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % max; };
  for (let i = 0; i < 500; i++) {
    const from = random(state.doc.length + 1), to = Math.min(state.doc.length, from + random(5));
    const change = { from, to, insert: pieces[random(pieces.length)] };
    const transaction = state.update({ changes: change });
    index = api.updateNoteSyntaxContext(index, transaction); state = transaction.state;
    assert.deepEqual(result(index), result(api.scanNoteSyntaxContext(state)), 'random ' + i + ': ' + JSON.stringify(change) + '\n' + state.doc.toString());
    checks++;
  }
}
// Isolated edits retain the original rich context instead of progressively
// reducing random input to malformed source.
for (const value of [fixture, '[TOC]\n\nparagraph\ncontinued\n---\n\n# Next\n\n    nested\n\n## Last',
  '[TOC]\n\n# Root\n\n- list\n\n  ## child\n\n# Real\n\n[^x]: body\n\n    continuation\n\n[^x]',
  '[TOC]\n\n# Root\n\n\\[\n# hidden\n\\]\n\n## End\n\n[^x]: x\n']) {
  for (let from = 0; from <= value.length; from += 5) {
    for (const insert of ['[', '$', '`', '\n', '\n\n', '<!--', '%%', '# ', '- ', '> ', '    ', '[^x]: y']) {
      sequence(value, [{ from, to: Math.min(value.length, from + 2), insert }]);
    }
  }
}
// Ordinary edits in a large document must not enter the full-document scanner.
let state = CM.EditorState.create({ doc: '[TOC]\n\n# Heading\n\n' + 'paragraph with $a+b$ and [r].\n\n'.repeat(4000) + '\n[r]: /target.md\n' });
let index = api.scanNoteSyntaxContext(state); context.fullScans = 0;
for (const insert of ['x', '[', '#', '$', '`']) {
  const transaction = state.update({ changes: { from: 12, insert } });
  index = api.updateNoteSyntaxContext(index, transaction); state = transaction.state;
}
assert.equal(context.fullScans, 0, 'local heading edits do not scan the full document');
assert.deepEqual(result(index), result(api.scanNoteSyntaxContext(state)));
// Bound both subtree walks, independently of wall-clock timing.
for (const count of [250, 500, 1000]) {
  const scan = context.RelatumNoteLiveSyntax.scanNoteHeadings('[TOC]\n\n# Root\n\n' + 'paragraph `code`\n\n'.repeat(count));
  let steps = 0, step;
  do { step = scan.next(); steps++; } while (!step.done);
  assert(steps < count * 20 + 100, 'heading scan work stays linear: ' + count + ' / ' + steps);
  assert.equal(context.headingRangeObjects, count, 'each inline-code interval is stored once');
}
console.log(JSON.stringify({ checks, localFullScans: 0, linearHeadingTraversal: true, rangeObjects: [250, 500, 1000] }));

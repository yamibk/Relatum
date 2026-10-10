'use strict';
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const root = path.resolve(__dirname, '..'), context = { console };
vm.runInNewContext(fs.readFileSync(path.join(root, 'assets/vendor/codemirror/relatum-codemirror.min.js'), 'utf8'), context);
context.window = context;
for (const name of ['markdown-table.js', 'markdown.js', 'note-live-editor.js', 'note-outline.js']) vm.runInNewContext(fs.readFileSync(path.join(root, 'assets', name), 'utf8'), context);
const scan = source => JSON.parse(JSON.stringify(context.RelatumNoteLiveSyntax.noteHeadingsFromString(source)));
const fence = '`'.repeat(3);
const source = [
  '---', 'title: Example', '# YAML', '---', '',
  '# Root', '### Skipped', '## Same', '## Same', '#### Four', '##### Five', '###### Six', '',
  'Underlined one', '===', '', 'Underlined two', '---', '',
  fence + 'md', '# Code', fence, '', '    # Indented', '',
  '> # Quote', '', '> [!note]', '> ## Callout', '', '- ### List', '  #### Nested', '',
  '<div>', '# HTML', '</div>', '', '<!--', '# HTML comment', '-->', '',
  '%%', '# Comment', '%%', '', '$$', '# Math', '$$', '', '\\[', '## Other math', '\\]', '',
  '# **Bold** [Link](https://example.com) `code` $x^2$',
  '## [[Target|Alias]]', '## `[[Literal|Wiki]]`', '## Escaped \\*text\\*', '', '# Last', '',
].join('\n');
const headings = scan(source);
assert.deepEqual(headings.map(item => item.level), [1, 3, 2, 2, 4, 5, 6, 1, 2, 1, 2, 2, 2, 1]);
assert.deepEqual(headings.map(item => item.label), ['Root', 'Skipped', 'Same', 'Same', 'Four', 'Five', 'Six',
  'Underlined one', 'Underlined two', 'Bold Link code $x^2$', 'Alias', '[[Literal|Wiki]]', 'Escaped *text*', 'Last']);
assert.notEqual(headings[2].from, headings[3].from, 'duplicate titles retain their own source positions');
for (const item of headings) assert(source.slice(item.from, item.to).includes(item.text.split(' ')[0]), 'positions refer to the real source');
for (const value of [fence + '\n# Hidden', '<!--\n# Hidden', '%%\n# Hidden', '$$\n# Hidden', '\\[\n# Hidden']) {
  assert.deepEqual(scan(value), [], 'unfinished protected blocks cannot generate phantom headings');
}
assert.deepEqual(scan('##\n\nplain\n\n---\n'), [], 'empty and incomplete titles are not entries');
assert.deepEqual(scan('Text\nwith **bold**\n===\n').map(item => item.label), ['Text with bold']);
assert.deepEqual(scan('# `%% literal` after\n## Real\n').map(item => item.label), ['%% literal after', 'Real']);
assert.deepEqual(scan('# Before <!-- hidden --> after\n').map(item => item.label), ['Before after']);
assert.deepEqual(scan('# $a*b*c$ and \\(a_b_c\\)\n## $x \\text{**foo**}$\n### `a\\*b`\n').map(item => item.label),
  ['$a*b*c$ and \\(a_b_c\\)', '$x \\text{**foo**}$', 'a\\*b'], 'math source and literal code survive Markdown label cleanup');
assert.deepEqual(scan('# $x%%y$\n## $x <!-- y --> z$\n### Next\n').map(item => item.label),
  ['$x%%y$', '$x <!-- y --> z$', 'Next'], 'comment-like text inside formulas stays literal');
assert.deepEqual(scan('# <https://example.com> [Name](https://example.com) ![Alt](pic)\n').map(item => item.label),
  ['https://example.com Name Alt'], 'autolinks retain their displayed URL');
assert.deepEqual(scan('A | B\n--- | ---\n# Cell | value\n\n# Real\n').map(item => item.label), ['Real'], 'heading-looking cells follow the shared table grammar');
assert.deepEqual(scan('# A\r\n\r\nTitle\r\n---\r\n').map(item => item.from), [0, 5], 'source positions follow the editor LF representation');

const rendered = context.MarkdownMini.renderResult(source, { noteTags: true, noteBlocks: true, noteHeadings: headings });
assert.equal(rendered.error, false);
assert.equal((rendered.html.match(/data-note-heading-from=/g) || []).length, headings.length);
for (const item of headings) assert(rendered.html.includes('<h' + item.level + ' data-note-heading-from="' + item.from + '"'), 'reading headings retain exact source anchors');
assert(!context.MarkdownMini.render('Underlined\n---').includes('<h2'), 'the note extension does not alter ordinary canvas Markdown');
assert(context.MarkdownMini.render('## ordinary').includes('data-ln="0"'), 'ordinary heading line metadata remains available');

const at = context.RelatumNoteOutline.headingAt;
assert.equal(at(headings, -1), -1);
assert.equal(at(headings, headings[3].from), 3);
assert.equal(at(headings, source.length), headings.length - 1);
const map = context.RelatumNoteOutline.mapHeadingPosition;
assert.equal(map(headings[3], source, 'prefix\n' + source), headings[3].from + 7);
assert.equal(map(headings[3], source, source + 'suffix'), headings[3].from);
assert.equal(map(headings[3], source, source.slice(0, headings[3].from) + source.slice(headings[3].to)), null, 'deleted targets are abandoned');

const iterator = context.RelatumNoteLiveSyntax.scanNoteHeadings('# Top\n\n' + 'plain\n'.repeat(20000) + '\n## End');
let steps = 0, result;
do { result = iterator.next(); steps++; } while (!result.done);
assert(steps > 20000, 'long scans yield between source/parser steps');
assert.deepEqual(JSON.parse(JSON.stringify(result.value.map(item => item.label))), ['Top', 'End']);
console.log('note outline regression: ok');

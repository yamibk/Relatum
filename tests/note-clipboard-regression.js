'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const fixture = require('./note-clipboard-fixture');
const sandbox = { window: {} };
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../assets/markdown.js'), 'utf8'), sandbox);
const { normalizePastedMath: normalize, mathRanges, renderResult } = sandbox.window.MarkdownMini;
const formula = String.raw`\\(x\\)`, standard = String.raw`\(x\)`;
assert.equal(normalize(fixture.copied), fixture.expected);
assert.equal(normalize(fixture.expected), fixture.expected, 'normalization is idempotent');
assert.equal(mathRanges(normalize(fixture.copied)).length, 9);
assert.equal(renderResult(normalize(fixture.copied), { noteBlocks: true }).features.math, true);
assert.equal(normalize('普通文字', () => { throw Error('ordinary paste must not read the document'); }), '普通文字');
assert.equal(normalize(formula), standard);
assert.equal(normalize(formula, { before: '前文', after: '后文' }), standard);
assert.equal(normalize(formula, { before: fixture.copied + '\n', after: '\n' + fixture.copied }), standard, 'old text only supplies context');
assert.equal(normalize(formula.replaceAll('x', '🙂中文')), standard.replaceAll('x', '🙂中文'));
const unchanged = [
  String.raw`\[\frac{a}{b}\]`, String.raw`$$\int x\\,dx$$`, String.raw`\(\text{file\_name}\)`,
  '`' + formula + '`', '`` ' + formula + ' ` tick ``', '`multiline\n' + formula + '\ncode`',
  '```tex\n' + formula + '\n```', '~~~tex\n' + formula, '> ```\n> ' + formula + '\n> ```',
  '- ```\n  ' + formula + '\n  ```', '    ' + formula, '\t' + formula, String.raw`    \\[x\\]`,
  '<!-- ' + formula + ' -->', '<!-- unfinished\n' + formula, '%% ' + formula + ' %%',
  '---\nexample: ' + formula + '\n---', '---\nexample: ' + formula,
  '[link](https://example.test/' + formula + ')', '[id]: https://example.test/' + formula,
  'https://example.test/' + formula, 'www.example.test/' + formula,
  '<a title="' + formula + '">link</a>', '<https://example.test/' + formula + '>',
  String.raw`\\(\\)`, String.raw`\\[ \\]`, String.raw`\\(x`, String.raw`x\\)`,
  String.raw`\\(x\)`, String.raw`\(x\\)`, String.raw`\\(x\\]`,
  String.raw`\\\(x\\\)`, String.raw`\\\\(x\\\\)`,
  String.raw`\\[ outer \\(inner\\) \\]`, '\\\\(x\ny\\\\)',
  '\\\\(' + 'x'.repeat(4096) + '\\\\)', '\\\\[' + 'x'.repeat(32768) + '\\\\]',
];
for (const text of unchanged) assert.equal(normalize(text), text, text);
for (const [before, after] of [
  ['```\n', '\n```'], ['~~~\n', ''], ['`prefix ', ' suffix`'], ['<!-- ', ' -->'], ['%% ', ' %%'],
  ['---\nexample: ', '\n---'], ['[link](https://example.test/', ')'], ['[ref]: ', '\n'], ['    ', ''],
  ['https://example.test/', ''],
  ['$$\n', '\n$$'], [String.raw`\[`, String.raw`\]`],
]) assert.equal(normalize(formula, { before, after }), formula, JSON.stringify({ before, after }));
assert.equal(normalize(String.raw`\\)`, { before: String.raw`\\(x`, after: '' }), String.raw`\\)`, 'a paste never rewrites old boundaries');
assert.equal(normalize('- item\n    ' + formula), '- item\n    ' + standard, 'list continuation is prose');
assert.equal(normalize('> ```\n> literal\n' + formula), '> ```\n> literal\n' + standard, 'leaving a quote ends its fenced code');
assert.equal(normalize('\\\\[\n    x+1\n\\\\]'), '\\[\n    x+1\n\\]', 'display math may indent its TeX');
assert.equal(normalize('\n```\n' + formula, { before: '```\n', after: '' }), '\n```\n' + formula, 'pasting into code keeps the entire payload literal');
assert.equal(normalize('> [!note]\r\n> ' + formula + '\r\n'), '> [!note]\r\n> ' + standard + '\r\n');
const tex = String.raw`\begin{aligned}a&=1\\b&=2\end{aligned}+\{x\}+\text{file\_name}+\%+\verb|\underbrace{x}\_{literal}\\,|`;
assert.equal(normalize('\\\\[' + tex + '\\\\]'), '\\[' + tex + '\\]', 'legal TeX is preserved');
assert.equal(normalize(String.raw`\\[\underbrace{\frac{x}{\{a\}}}\_{\text{label}}\\]`),
  String.raw`\[\underbrace{\frac{x}{\{a\}}}_{\text{label}}\]`);
assert.equal(normalize(String.raw`\\[\text{\underbrace{x}\_{literal}\\,} + \underbrace{x}\_{missing\\]`),
  String.raw`\[\text{\underbrace{x}\_{literal}\\,} + \underbrace{x}\_{missing\]`, 'literal text and incomplete annotation stay intact');
assert.equal(normalize(formula, { before: '    ', after: '' }, true), standard, 'cell text is inline syntax');
console.log('note clipboard regression: ok');

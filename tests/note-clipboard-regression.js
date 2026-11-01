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
const comparisonsCopied = String.raw`即使不知道 \\(t\<a\\) 期间的过程，只要知道 \\(t=a\\) 时的 \\(g(a)\\)。

- \\(t\<a\\)：电压源为 \\(A\\)，已知 \\(t\leq a\\) 的表达式。

\\[ u_c(a^+)=g(a) \\]

\\[ \boxed{u\_{\text{new}}(t)=B+[g(a)-B]e^{-\frac{t-a}{RC}}} \\]

之后计算 \\(t>a\\) 时的新旧函数之差。

\\[ \begin{aligned} \Delta u(t)={}&u\_{\text{new}}(t)\\\ &-u\_{\text{old}}(t) \end{aligned} \\]`;
const comparisonsExpected = String.raw`即使不知道 \(t<a\) 期间的过程，只要知道 \(t=a\) 时的 \(g(a)\)。

- \(t<a\)：电压源为 \(A\)，已知 \(t\leq a\) 的表达式。

\[ u_c(a^+)=g(a) \]

\[ \boxed{u_{\text{new}}(t)=B+[g(a)-B]e^{-\frac{t-a}{RC}}} \]

之后计算 \(t>a\) 时的新旧函数之差。

\[ \begin{aligned} \Delta u(t)={}&u_{\text{new}}(t)\\\ &-u_{\text{old}}(t) \end{aligned} \]`;
assert.equal(normalize(comparisonsCopied), comparisonsExpected, 'a comparison must not consume later formulas through a distant >');
assert.equal(normalize(comparisonsExpected), comparisonsExpected, 'standard math remains byte-for-byte unchanged');
assert.equal(mathRanges(normalize(comparisonsCopied)).length, 10, 'all inline and display formulas are recovered');
assert.equal(normalize(String.raw`\\(x<a > b\\) \\(c\\)`), String.raw`\(x<a > b\) \(c\)`, 'tag-shaped comparisons belong to their formula');
assert.equal(normalize(String.raw`\\(x<a\\) \\(c\\)`), String.raw`\(x<a\) \(c\)`, 'an unmatched < is also math content');
assert.equal(normalize(String.raw`\\[x\<a \quad u \_ {\text{old}}\quad \underbrace{x}\_{\text{label}}\\]`),
  String.raw`\[x<a \quad u _ {\text{old}}\quad \underbrace{x}_{\text{label}}\]`);
const copiedLiterals = String.raw`\text{u\_{old} x\<y}+\verb|u\_{old} x\<y|+\{x\}+\%+x\_y+\>+\\`;
assert.equal(normalize('\\\\[ ' + copiedLiterals + ' \\\\]'), '\\[ ' + copiedLiterals + ' \\]', 'text, verb, literal underscores, spacing and row breaks stay intact');
assert.equal(normalize(String.raw`\\[u\_{unfinished\\]`), String.raw`\[u\_{unfinished\]`, 'an incomplete grouped subscript is not repaired');
assert.equal(normalize('\\\\[x\\<y % u\\_{literal} x\\<y\n\\\\]'), '\\[x<y % u\\_{literal} x\\<y\n\\]', 'TeX comments remain literal');
for (const literal of [
  '`' + comparisonsCopied + '`', '```tex\n' + comparisonsCopied + '\n```',
  '<!-- ' + comparisonsCopied + ' -->', '%% ' + comparisonsCopied + ' %%',
]) assert.equal(normalize(literal), literal, 'comparison samples inside literals remain untouched');
for (const tag of [
  '<a data-label="1 > 0" title="' + formula + '">',
  "<a data-label='1 > 0'\n title='" + formula + "'>",
  '<custom-element data-formula=' + formula + '>',
]) assert.equal(normalize(tag + 'link</a>\n\n' + formula), tag + 'link</a>\n\n' + standard, 'HTML attributes stay literal without hiding following formulas');
assert.equal(normalize(formula, { before: '<a title="1 > 0 ', after: '">link</a>' }), formula, 'quoted > does not end the HTML paste context');
assert.equal(normalize(String.raw`\\(x<a\\)`, { before: '    ', after: '' }, true), String.raw`\(x<a\)`, 'inline table paste uses the same comparison guards');
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
for (const [prefix, marker] of [['', '```'], ['> ', '~~~'], ['> > ', '````']]) {
  const code = prefix + marker + 'md\n' + prefix + '> ' + marker + '\n' + prefix + formula + '\n' + prefix + marker;
  assert.equal(normalize(code + '\n\n' + formula), code + '\n\n' + standard,
    'quoted fence examples stay literal and do not suppress later prose normalization');
  assert.equal(normalize(formula, { before: prefix + marker + 'md\n' + prefix + '> ' + marker + '\n' + prefix, after: '\n' + prefix + marker }), formula,
    'pasting after a quoted fence example remains inside code');
}
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

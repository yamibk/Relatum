const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'assets', 'markdown-table.js'), 'utf8');
const window = {};
vm.runInNewContext(source, { window });

const table = window.MarkdownTable;
assert(table, 'MarkdownTable should be exposed');

const rich = [
  '| 名称 | 内容 | 公式 |',
  '| --- | :---: | ---: |',
  '| A | x\\|y | $a|b$ |',
  '| B | `left|right` | {hl:yellow|重点} |',
  '| C | **粗体** 与 *斜体* | [资料](https://example.com/a|b) |',
].join('\n');
const parsed = table.parse(rich);
assert.strictEqual(parsed.ok, true);
assert.deepStrictEqual(Array.from(parsed.model.header), ['名称', '内容', '公式']);
assert.strictEqual(parsed.model.rows[0][1], 'x|y');
assert.strictEqual(parsed.model.rows[0][2], '$a|b$');
assert.strictEqual(parsed.model.rows[1][1], '`left|right`');
assert.strictEqual(parsed.model.rows[1][2], '{hl:yellow|重点}');
assert.strictEqual(parsed.model.rows[2][1], '**粗体** 与 *斜体*');
assert.strictEqual(parsed.model.rows[2][2], '[资料](https://example.com/a|b)');
assert.deepStrictEqual(Array.from(parsed.model.align), ['', 'center', 'right']);

const roundTrip = table.parse(table.serialize(parsed.model));
assert.strictEqual(roundTrip.ok, true);
assert.strictEqual(roundTrip.model.rows[0][1], 'x|y');
assert.strictEqual(roundTrip.model.rows[0][2], '$a|b$');
assert.strictEqual(roundTrip.model.rows[2][2], '[资料](https://example.com/a|b)');

const blankDefault = table.createDefault(3, 3, '');
assert.deepStrictEqual(Array.from(blankDefault.header), ['', '', '']);
assert.strictEqual(blankDefault.rows.length, 2);
assert.deepStrictEqual(Array.from(blankDefault.rows[0]), ['', '', '']);
const blankRoundTrip = table.parse(table.serialize(blankDefault));
assert.strictEqual(blankRoundTrip.ok, true);
assert.deepStrictEqual(Array.from(blankRoundTrip.model.header), ['', '', '']);
assert.strictEqual(blankRoundTrip.model.rows.length, 2);

const headerOnly = { header: ['名称'], rows: [], align: [''] };
const headerOnlyMarkdown = table.serialize(headerOnly);
assert.strictEqual(headerOnlyMarkdown, '| 名称 |\n| --- |');
const headerOnlyRoundTrip = table.parse(headerOnlyMarkdown, { ensureBodyRow: false });
assert.strictEqual(headerOnlyRoundTrip.ok, true);
assert.strictEqual(headerOnlyRoundTrip.model.rows.length, 0);

const ragged = table.parse('| A | B |\n| --- | --- |\n| 1 |\n| 2 | 3 | 4 |');
assert.strictEqual(ragged.ok, true);
assert.strictEqual(ragged.model.header.length, 3);
assert.deepStrictEqual(Array.from(ragged.model.rows[0]), ['1', '', '']);
assert.deepStrictEqual(Array.from(ragged.model.rows[1]), ['2', '3', '4']);

const doc = '开头\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n\n结尾';
const found = table.findTables(doc);
assert.strictEqual(found.length, 1);
assert.strictEqual(found[0].startLine, 2);
assert.strictEqual(doc.slice(found[0].startOffset, found[0].endOffset), found[0].markdown);

const tsv = table.parseDelimited('姓名\t分数\n甲\t95\n乙\t88');
assert.deepStrictEqual(Array.from(tsv.header), ['姓名', '分数']);
assert.deepStrictEqual(Array.from(tsv.rows[1]), ['乙', '88']);

const markdownWindow = {};
const markdownSource = fs.readFileSync(path.join(__dirname, '..', 'assets', 'markdown.js'), 'utf8');
vm.runInNewContext(markdownSource, { window: markdownWindow, URL });
const linkHtml = markdownWindow.MarkdownMini.render('[资料](https://example.com/a|b)');
const mathHtml = markdownWindow.MarkdownMini.render('$a|b$');
assert(linkHtml.includes('data-href="https://example.com/a|b"'));
assert(mathHtml.includes('$a|b$'));

console.log('markdown-table regression: ok');

'use strict';
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
global.window = global;
for (const file of ['markdown.js', 'note-cards.js']) vm.runInThisContext(fs.readFileSync(path.join(__dirname, '../assets', file), 'utf8'), { filename: file });
const cards = RelatumNoteCards;
const body = '### [zap] 效率 **标题**\n第一段 $I=U/R$。\n\n- 一\n- 二\n\n1. 三\n2. 四\n\n---\n\n### 无图标\n[参考](https://example.com) `code`';
assert.equal(cards.parse(body).cards.length, 2);
assert.deepEqual(cards.parse(body.replace(/\n/g, '\r\n')), cards.parse(body));
assert.equal(cards.parse('### [unknown] 标题').cards[0].title, '[unknown] 标题');
assert.equal(cards.parse('### [unknown] 标题').cards[0].icon, '');
assert.equal(cards.icons.length, 12);
assert.equal(cards.parse('### [zap]').valid, false, 'an icon alone is not a card title');
for (const icon of cards.icons) assert.equal(cards.parse('### [' + icon + '] 标题').cards[0].icon, icon);
assert.equal(cards.parse(body).cards[0].color, '', 'old cards keep their default background');
for (const color of MarkdownMini.noteBlockCatalog.colors) {
  for (const prefix of ['[!' + color.name + ']', '[book] [!' + color.name + ']', '[!' + color.name + '] [book]']) {
    const source = '### ' + prefix + ' **标题**\n正文', card = cards.parse(source).cards[0];
    assert.equal(card.title, '**标题**'); assert.equal(card.color, color.name);
    assert.equal(card.icon, prefix.includes('[book]') ? 'book' : '');
    const result = cards.render(source);
    assert(result.html.includes('data-note-card-color="' + color.name + '"'));
    assert(result.html.includes('--note-card-bg-light:' + color.light + ';--note-card-bg-dark:' + color.dark + ';'));
    assert(result.html.includes('<strong>标题</strong>'));
    assert.equal(result.features.math, false);
  }
  for (const prefix of ['[!' + color.name + ']', '[book] [!' + color.name + ']', '[!' + color.name + '] [book]']) assert.equal(cards.parse('### ' + prefix).valid, false, 'metadata alone needs a title');
}
for (const [source, title, icon, color] of [
  ['[!unknown] 标题', '[!unknown] 标题', '', ''],
  ['[book] [!unknown] 标题', '[!unknown] 标题', 'book', ''],
  ['[!blue] [unknown] 标题', '[unknown] 标题', '', 'blue'],
  ['[unknown] [!blue] 标题', '[unknown] [!blue] 标题', '', ''],
  ['[!blue] [!red] 标题', '[!red] 标题', '', 'blue'],
  ['[book] [target] 标题', '[target] 标题', 'book', ''],
  ['[!blue]标题', '[!blue]标题', '', ''],
  ['[!#123456] 标题', '[!#123456] 标题', '', ''],
]) assert.deepEqual(cards.parse('### ' + source).cards[0], { title, icon, color, body: '' });
const tintedSource = '### [book] [!purple] 标题\n正文\n---\n### [!blue] [target] 行动\n内容\n---\n### 原样\n普通卡片';
assert.deepEqual(cards.parse(tintedSource.replace(/\n/g, '\r\n')), cards.parse(tintedSource));
assert.equal((cards.render(tintedSource).html.match(/data-note-card-color=/g) || []).length, 2, 'tint only the specified cards');
assert(!cards.render(body).html.includes('--note-card-bg-'), 'old HTML does not gain tint styles');
for (const invalid of ['', ' ', '缺少标题', '### ', '### a\n---', '### a\n### b', '### a\n$$x$$', '### a\n文字 $$x$$', '### a\n![x](a.png)', '### a\n```cards', '### a\n> quote', '### ' + 'a'.repeat(cards.MAX_LINE), '### a\n' + 'a'.repeat(cards.MAX_SOURCE)]) assert.equal(cards.parse(invalid).valid, false, invalid.slice(0, 60));
const rendered = cards.render(body);
assert(rendered.features.math); assert(rendered.html.includes('<ul>')); assert(rendered.html.includes('<ol start="1">'));
assert(rendered.html.includes('<strong>标题</strong>')); assert(rendered.html.includes('href="https://example.com"'));
assert.equal((rendered.html.match(/note-card-icon/g) || []).length, 1);
assert.equal(cards.render('### a\n`$$literal$$`').features.math, false);
const unsafe = cards.render('### <script>bad()</script>\n[x](javascript:alert(1))\n<svg onload="bad()">');
assert(!unsafe.html.includes('<script')); assert(!unsafe.html.includes('<svg onload')); assert(!unsafe.html.includes('href="javascript:'));
const unsafeTint = cards.render('### [!blue" style="background:url(https://evil.invalid)] <img src=x onerror=bad()>\n[x](javascript:alert(1))');
assert(!unsafeTint.html.includes('data-note-card-color=')); assert(!/<[^>]+\sstyle=/.test(unsafeTint.html));
assert(!unsafeTint.html.includes('<img')); assert(!unsafeTint.html.includes('href="javascript:'));
const fenced = '```cards\n' + body + '\n```';
assert(MarkdownMini.renderResult(fenced).html.includes('md-code'), 'other Markdown hosts keep ordinary fences');
const renderFence = block => block.language === 'cards' ? cards.render(block.source)?.html ?? null : null;
assert(MarkdownMini.renderResult(fenced, { renderFence }).html.includes('note-cards-grid'));
assert(!MarkdownMini.renderResult(fenced.slice(0, -3), { renderFence }).html.includes('note-cards-grid'));
assert(MarkdownMini.renderResult('```cards\nmissing title\n```', { renderFence }).html.includes('md-code'));
assert(MarkdownMini.renderResult('> [!white]\n>\n' + fenced.split('\n').map(line => '> ' + line).join('\n'), { noteBlocks: true, renderFence }).html.includes('note-cards-grid'));
vm.runInThisContext(fs.readFileSync(path.join(__dirname, '../assets/vendor/codemirror/relatum-codemirror.min.js'), 'utf8'));
vm.runInThisContext(fs.readFileSync(path.join(__dirname, '../assets/note-live-editor.js'), 'utf8'));
assert.deepEqual(RelatumNoteLiveSyntax.noteHeadingsFromString('# Outside\n\n' + fenced).map(item => item.label), ['Outside']);
console.log('note cards regression: ok');

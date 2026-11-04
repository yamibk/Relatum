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
  ['[!blue]标题', '标题', '', 'blue'],
  ['[!#123456] 标题', '[!#123456] 标题', '', ''],
]) { const { title: actualTitle, icon: actualIcon, color: actualColor, body } = cards.parse('### ' + source).cards[0]; assert.deepEqual({ title: actualTitle, icon: actualIcon, color: actualColor, body }, { title, icon, color, body: '' }); }
const tintedSource = '### [book] [!purple] 标题\n正文\n---\n### [!blue] [target] 行动\n内容\n---\n### 原样\n普通卡片';
assert.deepEqual(cards.parse(tintedSource.replace(/\n/g, '\r\n')), cards.parse(tintedSource));
assert.equal((cards.render(tintedSource).html.match(/data-note-card-color=/g) || []).length, 2, 'tint only the specified cards');
assert(!cards.render(body).html.includes('--note-card-bg-'), 'old HTML does not gain tint styles');
for (const invalid of ['', ' ', '缺少标题', '### ', '### a\n$$x$$', '### a\n文字 $$x$$', '### a\n![x](a.png)', '### a\n```cards', '### a\n> quote', '### ' + 'a'.repeat(cards.MAX_LINE), '### a\n' + 'a'.repeat(cards.MAX_SOURCE)]) assert.equal(cards.parse(invalid).valid, false, invalid.slice(0, 60));
for (let hashes = 1; hashes <= 6; hashes++) for (const gap of ['', ' ', '\t', '   ']) {
  const source = '#'.repeat(hashes) + gap + '[ BOOK ][ ! Purple ]整理笔记\n正文';
  const card = cards.parse(source).cards[0]; assert.equal(card.title, '整理笔记'); assert.equal(card.icon, 'book'); assert.equal(card.color, 'purple');
}
assert.equal(cards.parse('# A\n正文\n##B\n正文\n###### C').cards.length, 3, 'headings start cards without separators');
assert.equal(cards.parse('A\n正文\n---\n[!blue]B\n正文\n---').cards.length, 2, 'explicit separators allow plain titles and trailing separators');
assert.equal(cards.parse('### \\[!purple] 标题').cards[0].color, '', 'escaped metadata remains literal');
const richSource = '@columns：3\n@style outline\n@density: compact\n\n##[book][!Purple]标题\n@subtitle: 副标题 $x$\n@badge：待复习\n@value: 3 个概念\n@footer: [资料](https://example.com)\n正文\n@style: band\n\n# B\n@style: stripe\n@span full\n正文';
const richModel = cards.parse(richSource), rich = cards.render(richSource);
assert.deepEqual(richModel.settings, { columns: '3', style: 'outline', density: 'compact' });
assert.equal(richModel.cards[0].body, '正文\n@style: band', 'directives after body text are literal');
for (const selector of ['note-card-subtitle', 'note-card-badge', 'note-card-value', 'note-card-footer', 'data-style="stripe"', 'data-span="full"']) assert(rich.html.includes(selector));
assert(rich.features.math); assert(rich.html.includes('data-columns="3"'));
assert(cards.render('### 单卡').html.includes('data-single="1"'));
const partial = cards.parse('@columns: 9\n@unknown: something\n### 好卡\n@style: bad\n@badge: 有效\n@badge: 重复\n正文\n---\n### [book]\n---\n# 另一张\n正文');
assert(partial.valid); assert.equal(partial.cards.length, 2); assert.equal(partial.cards[0].badge, '有效');
assert.equal(partial.diagnostics.length, 5); assert(cards.render('@style: bad\n# a').html.includes('@style: bad'));
assert(cards.render('# good\n---\n# bad\n![x](a.png)').html.includes('![x](a.png)'), 'invalid cards preserve raw content beside valid cards');
function patched(source, target, fields) {
  const changes = cards.patch(source, target, fields); assert(changes);
  return changes.slice().reverse().reduce((value, edit) => value.slice(0, edit.from) + edit.insert + value.slice(edit.to), source);
}
const patchSource = '@style：outline\n\n##[BOOK][!Purple]标题\n@unknown: 保留这行\n@subtitle: 旧副标题\n\n正文 **不改**\n---\n# 第二张\n文字';
const patchResult = patched(patchSource, 0, { color: 'blue', icon: '', subtitle: '新副标题', badge: '重点', span: 'full' });
assert(patchResult.includes('@unknown: 保留这行')); assert(patchResult.includes('正文 **不改**\n---\n# 第二张\n文字'));
assert.equal(cards.parse(patchResult).cards[0].color, 'blue'); assert.equal(cards.parse(patchResult).cards[0].icon, '');
assert.equal(cards.parse(patchResult).cards[0].badge, '重点');
assert.equal(cards.parse(patched(patchSource, 'group', { columns: '3', style: 'band' })).settings.columns, '3');
const crlf = patchSource.replace(/\n/g, '\r\n');
assert.equal(patched(crlf, 0, { subtitle: '新副标题' }), crlf.replace('旧副标题', '新副标题'), 'patches preserve CRLF and untouched source');
assert.equal(cards.patch(patchSource, 0, { badge: 'bad\n# injected' }), null);
assert.equal(cards.patch(patchSource, 'group', { style: 'url(evil)' }), null);
assert.equal(cards.patch(patchSource, 0, { color: '#fff' }), null);
assert.equal(cards.parse(patched('# [!blue] [!red] 字面标题', 0, { color: '' })).cards[0].color, '', 'removing a tint cannot promote a literal duplicate to metadata');
assert.equal(cards.parse(patched('# [book] [target] 字面标题', 0, { icon: '' })).cards[0].icon, '', 'removing an icon preserves literal title markers');
const cleared = cards.parse(patched('# A\n@subtitle: 原值\n@subtitle: 重复值\n@badge: 重点\n正文', 0, { subtitle: '' }));
assert.equal(cleared.cards[0].subtitle, ''); assert.equal(cleared.cards[0].badge, '重点'); assert.equal(cleared.cards[0].diagnostics.length, 1, 'clearing a field does not promote duplicates or consume later fields as body text');
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

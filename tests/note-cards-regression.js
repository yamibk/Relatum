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
const styledHeader = String.raw`##[book][!blue]\red\B\bbb\##\####\num\right [target] 67%` + '\r\n正文';
const styledCard = cards.parse(styledHeader).cards[0];
assert.deepEqual(styledCard.titleStyle, { bold: true, depth: 3, size: 6, tabular: true, color: 'red', align: 'right' });
assert.equal(styledCard.title, '[target] 67%');
assert.equal(styledHeader.slice(styledCard.header.titleFrom, styledCard.header.to), '[target] 67%');
const updatedHeader = patched(styledHeader, 0, { color: 'rose', icon: '' });
assert.equal(updatedHeader, styledHeader.replace('[book][!blue]', '[!rose]'));
assert.deepEqual(cards.parse(updatedHeader).cards[0].titleStyle, styledCard.titleStyle);
const compactHeader = String.raw`#\red456`;
assert.equal(patched(compactHeader, 0, { icon: 'book' }), String.raw`#[book] \red456`);
assert.equal(cards.parse(compactHeader).cards[0].title, '456');
assert.equal(cards.parse(String.raw`###\red\456`).cards[0].title, String.raw`\456`);
assert.equal(cards.parse(String.raw`#\red \center 标题`).cards[0].title, String.raw`\center 标题`);
assert.equal(cards.parse(String.raw`#\red\unknown 标题`).cards[0].title, String.raw`\unknown 标题`);
for (const command of ['check', '!check', 'bar1:6', 'divider', 'unknown']) {
  const literal = '\\' + command + ' 标题';
  const card = cards.parse('#' + literal).cards[0];
  assert.equal(card.title, literal);
  assert.equal(card.titleStyle, undefined);
  assert.equal(cards.parse('#\\red' + literal).cards[0].title, literal);
}
assert.equal(cards.parse(String.raw`#\B\###`).valid, false, 'style commands alone do not supply a title');
assert.equal(cards.parse('\\red 字面标题\n---\n# B').cards[0].title, '\\red 字面标题', 'plain headings keep their existing syntax');
assert(cards.render(String.raw`#\\red 字面标题`).html.includes(String.raw`>\red 字面标题<`));
assert(cards.render(String.raw`#\red $x$`).features.math);
const cleared = cards.parse(patched('# A\n@subtitle: 原值\n@subtitle: 重复值\n@badge: 重点\n正文', 0, { subtitle: '' }));
assert.equal(cleared.cards[0].subtitle, ''); assert.equal(cleared.cards[0].badge, '重点'); assert.equal(cleared.cards[0].diagnostics.length, 1, 'clearing a field does not promote duplicates or consume later fields as body text');
const rendered = cards.render(body);
const commands = String.raw`# 任务
\bbb\red\####\B 大字
\B\####\red\bbb 同样的样式
\#abcdefg\red
\redshift 照常显示
\\check 字面命令
 \check 缩进后照常显示
\red\blue\B 无颜色
\!check\check 互相抵消
\check\check 已完成
\!check 待完成
\check\bar 互相抵消
\bar1:2\bar1:4 互相抵消
\bar2:1 越界
\bar-1:6 负数
\bar1:0 零总数
\bar9007199254740993:9007199254740993 超范围
\bar0:6 起点
\bar6:6 终点
\bar1:6 手动
\bar 自动
# 其他任务
\bar 自动`;
const [taskCard, emptyCard] = cards.parse(commands).cards;
const [style, reordered, suffixed, unknown, escaped, indented, colorConflict] = taskCard.lines;
const appearance = ({ bold, color, depth, size }) => ({ bold, color, depth, size });
assert.deepEqual(appearance(style), { bold: true, color: 'red', depth: 3, size: 4 });
assert.deepEqual(appearance(style), appearance(reordered));
assert.equal(suffixed.text, String.raw`abcdefg\red`);
assert.equal(suffixed.size, 1);
for (const line of [unknown, escaped, indented]) assert.equal(line.styled, undefined);
assert.deepEqual(appearance(colorConflict), { bold: true, color: '', depth: 0, size: 0 });
const unchanged = taskCard.lines.filter(row => row.styled && !row.component);
assert.equal(unchanged.length, 11);
assert.equal(cards.taskEdit(commands, 0, taskCard.lines[7].number), null);
assert.equal(cards.taskEdit(commands, 1, emptyCard.lines[0].number), null);
assert.deepEqual(cards.taskEdit(commands, 0, taskCard.lines[8].number), [
  { from: 0, to: 6, expected: '\\check', insert: '\\!check' },
  { from: 6, to: 12, expected: '\\check', insert: '\\!check' },
]);
const commandHtml = cards.render(commands).html;
assert.equal((commandHtml.match(/type="checkbox"/g) || []).length, 2);
assert.deepEqual([...commandHtml.matchAll(/aria-valuetext="([^"]+)"/g)].map(match => match[1]), ['0/6', '6/6', '1/6', '1/2', '0/0']);
assert(commandHtml.includes(String.raw`\check 字面命令`));
assert(!commandHtml.includes(String.raw`\\check 字面命令`));
const layoutCommands = String.raw`#\center\right\blue\red\B\B 标题
\######\#\b\b\b\b\center\center\num 67%
\#\#\#
\divider
\divider 带文字
\\divider
\red\divider
\right\num\!check\!check 任务
\center\bar 进度`;
const layoutCard = cards.parse(layoutCommands).cards[0];
assert.deepEqual(layoutCard.titleStyle, { bold: true, depth: 0, size: 0, tabular: false, color: '', align: '' });
assert.equal(layoutCard.lines[0].size, 6);
assert.equal(layoutCard.lines[0].depth, 3);
assert.equal(layoutCard.lines[0].align, 'center');
assert.equal(layoutCard.lines[0].tabular, true);
assert.equal(layoutCard.lines[1].size, 3);
assert.equal(layoutCard.lines[3].text, '\\divider 带文字');
assert.equal(layoutCard.lines[5].text, '\\divider');
const layoutHtml = cards.render(layoutCommands).html;
assert.equal((layoutHtml.match(/<hr class="note-card-divider">/g) || []).length, 1);
assert(layoutHtml.includes('is-tabular" data-size="6" data-depth="3" data-align="center">67%'));
assert(layoutHtml.includes('aria-valuetext="0/1"'));
assert.deepEqual(cards.taskEdit(layoutCommands, 0, layoutCard.lines[6].number), [
  { from: 10, to: 17, expected: '\\!check', insert: '\\check' },
  { from: 17, to: 24, expected: '\\!check', insert: '\\check' },
]);
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
assert(RelatumNoteLiveSyntax.cardsTemplateAllowed('', 0));
assert(RelatumNoteLiveSyntax.cardsTemplateAllowed('ordinary text', 5));
for (const [source, position] of [['```js\nlet x\n```', 8], ['$$\nx\n$$', 4], ['---\ntitle: a\n---\ntext', 6], ['> [!note]\n> text', 13]]) assert(!RelatumNoteLiveSyntax.cardsTemplateAllowed(source, position), 'protected source cannot contain another Cards template');
assert.deepEqual(RelatumNoteLiveSyntax.noteHeadingsFromString('# Outside\n\n' + fenced).map(item => item.label), ['Outside']);
console.log('note cards regression: ok');

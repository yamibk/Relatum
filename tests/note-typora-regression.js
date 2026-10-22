'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const context = { window: {}, console }; vm.createContext(context);
for (const name of ['markdown-table.js', 'markdown.js']) vm.runInContext(fs.readFileSync(path.join(__dirname, '../assets', name), 'utf8'), context);
const M = context.window.MarkdownMini;
const source = [
  '[TOC]', '', '# 一级 Heading', '', '## 二级', '',
  '<u>下划线 **粗体**</u> x<sup>2</sup> H<sub>2</sub>O <kbd>Ctrl</kbd><br>换行', '',
  '[完整][REF]、[折叠][]、[简写]、[标题](https://example.com/a_(b) "说明")', '',
  'https://example.com/a_(b)。www.example.com，name@example.com。<https://example.com/>', '',
  '首注[^乙]，再注[^甲]，重复[^乙]，缺失[^无]。', '',
  '[ref]: https://example.com/ref "参考标题"', '[折叠]: /relative.md', '[简写]: #section', '',
  '[^甲]: 第二条注释', '[^乙]: 第一条 **重点**', '    续行', '',
  '```md', '[fake]: https://hidden.invalid', '不解析[^甲] <u>源码</u>', '[TOC]', '```', '',
  '> 一级', '>', '> > 二级', '> >', '> > > 三级', '',
  '<script>alert(1)</script> <u onclick="alert(1)">不执行</u>',
].join('\n');
const result = M.renderResult(source, { noteSyntax: true, noteBlocks: true });
assert.equal(result.error, false);
assert.match(result.html, /class="note-toc"/);
assert.match(result.html, /<u>下划线 <strong>粗体<\/strong><\/u>/);
assert.match(result.html, /x<sup>2<\/sup> H<sub>2<\/sub>O/);
assert.match(result.html, /<kbd>Ctrl<\/kbd><br>换行/);
assert.match(result.html, /data-href="https:\/\/example.com\/ref" title="参考标题">完整<\/a>/);
assert.match(result.html, /data-href="\/relative.md"/);
assert.match(result.html, /data-href="#section"/);
assert.match(result.html, /data-href="https:\/\/example.com\/a_\(b\)" title="说明"/);
assert.match(result.html, /data-href="https:\/\/www.example.com"/);
assert.match(result.html, /data-href="mailto:name@example.com"/);
assert.match(result.html, /class="note-footnotes"/);
assert.match(result.html, /第一条 <strong>重点<\/strong>/);
assert(result.html.indexOf('第一条 <strong>') < result.html.indexOf('第二条注释'));
assert.match(result.html, /缺失\[\^无\]/);
assert.match(result.html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
assert(!result.html.includes('<u onclick='));
assert(!result.html.includes('data-href="https://hidden.invalid"'));
assert.match(result.html, /<blockquote[\s\S]*<blockquote[\s\S]*<blockquote/);
assert(!M.render(source).includes('note-footnotes'), 'shared default renderer must keep its original grammar');
assert(M.render('<u>原文</u>').includes('&lt;u&gt;'));
const scanned = M.noteSyntax.scan(source);
assert.equal(scanned.uses.length, 3);
assert.deepEqual(Array.from(scanned.uses, item => item.number), [1, 2, 1]);
assert.equal(scanned.references.size, 3);
assert.equal(scanned.tocs.length, 1);
for (const item of scanned.uses) assert.equal(source.slice(item.from, item.to), '[^' + item.key + ']');
const guarded = M.renderResult('`www.example.com <u>x</u>` $x$\n\n\\[label][ref]\n\n[ref]: https://example.com', { noteSyntax: true });
assert(!guarded.html.includes('data-href='));
assert.match(guarded.html, /&lt;u&gt;/);
const links = M.noteSyntax.inline('网址 https://example.com/a_(b)). 邮件 a@example.com。', scanned);
assert.equal(links[0].target, 'https://example.com/a_(b)');
assert.equal(links[1].target, 'mailto:a@example.com');
assert.match(M.renderResult('https://example.com/my_file_a', {noteSyntax:true}).html,/>https:\/\/example.com\/my_file_a<\/a>/);
assert.match(M.renderResult('[<u>标题</u> **重点**](https://example.com)', {noteSyntax:true}).html,/><u>标题<\/u> <strong>重点<\/strong><\/a>/);
assert.equal(M.noteSyntax.scan('    [^x]\n\n[^x]: code').uses.length,0);
assert.equal(M.noteSyntax.scan('%%\n[^x]\n# hidden\n%%\n\n[^x]: note').uses.length,0);
assert.equal(M.noteSyntax.inline('$https://math.example/ [^x]$ <u>text</u>', scanned).filter(token=>token.kind==='autolink').length,0);
assert.match(M.renderResult('[标题][a:b]\n\n[a:b]: https://example.com',{noteSyntax:true}).html,/data-href="https:\/\/example.com"/);
const hostile = '[x]('.repeat(20000);
const start = performance.now();
assert.equal(M.noteSyntax.inline(hostile, scanned).filter(token => token.kind === 'link').length, 0);
assert(performance.now() - start < 1500, 'unclosed link parsing must stay bounded');
console.log('note Typora grammar regression: ok');

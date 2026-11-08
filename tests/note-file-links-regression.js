'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const sandbox = { window: {} };
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../assets/markdown.js'), 'utf8'), sandbox);
const md = sandbox.window.MarkdownMini;
const urls = ['file:///C:/实验/三表法实验指南.html', 'file:///C:/中文%20空格/guide%23%25%28v1%29.pdf',
  'file://localhost/D:/docs/guide.docx', 'FILE:///D:/docs/picture.png', 'file:///D:/docs/guide(v1).html'];
const tokens = source => md.noteSyntax.inline(source, md.noteSyntax.scan(source)).filter(t => /^(?:auto)?link$/.test(t.kind));
const render = source => md.renderResult(source, { noteSyntax: true, noteBlocks: true, noteTags: true, localImages: true }).html;
for (const url of urls) {
  for (const source of [url, '<' + url + '>', '[说明](' + url + ')', '[说明](<' + url + '>)', '[说明][ref]\n\n[ref]: ' + url]) {
    assert.equal(tokens(source)[0]?.target, url, source);
    assert(render(source).includes('data-href="' + url + '"'), source);
  }
  for (const source of ['`' + url + '`', '```md\n' + url + '\n```', '<!--\n' + url + '\n-->',
    '%%\n' + url + '\n%%', '$' + url + '$', '$$\n' + url + '\n$$', '\\[\n' + url + '\n\\]',
    '---\nlink: ' + url + '\n---', '![](' + url + ')']) {
    assert(!render(source).includes('data-href='), source);
  }
}
const spaced = 'file:///C:/中文 目录/guide (v1).html';
assert.equal(tokens('<' + spaced + '>')[0]?.target, spaced);
assert.equal(tokens('[标题](<' + spaced + '>)')[0]?.target, spaced);
assert.equal(tokens('(file:///C:/guide.html)。')[0]?.target, 'file:///C:/guide.html');
const literalTitle = '[标题 \\[重点\\] \\*星号\\* \\`代码\\`](file:///C:/guide.html)';
assert(render(literalTitle).includes('>标题 [重点] *星号* `代码`</a>'), 'clipboard title escapes remain visible literal text');
for (const url of ['file://server/share/test.html', 'file:///relative.html', 'file:///C:/bad\u0000.html', 'javascript:alert(1)', 'data:text/html,test']) {
  assert.equal(tokens('[说明](' + url + ')').length, 0, url);
}
for (const source of ['https://example.test/a', 'www.example.test', 'test@example.test', '[本地](other.md)']) assert(tokens(source).length);
assert.equal(md.pastedLinkMarkdown(urls[0], ''), urls[0], 'a plain URL is never rewritten');
console.log('note file links syntax regression: ok');

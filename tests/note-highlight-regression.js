'use strict';
const assert = require('node:assert/strict'), fs = require('node:fs'), vm = require('node:vm'), path = require('node:path');
const sandbox = { window: {} };
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../assets/markdown.js'), 'utf8'), sandbox);
const md = sandbox.window.MarkdownMini;
for (const color of md.noteSyntax.highlightColors) {
  const source = '=='+ color.emoji + '中文**bold**==';
  const result = md.renderResult(source, { noteSyntax: true, noteBlocks: true });
  assert(!result.error); assert(result.html.includes('data-hl="' + (color.id === 'default' ? 'yellow' : color.id) + '"'));
  assert(result.html.includes('<strong>bold</strong>')); assert(!color.emoji || !result.html.includes(color.emoji));
  assert(md.renderLabelResult(source, { noteSyntax: true }).html.includes('中文<strong>bold</strong>'));
  if (color.emoji) assert(md.renderResult(source).html.includes(color.emoji), 'other workspaces retain legacy interpretation');
  const span = md.noteSyntax.highlights('前😀' + source, 10)[0];
  assert.equal(span.from, 13); assert.equal(span.bodyFrom, 15 + color.emoji.length);
}
for (const source of ['`==🔴code==`', '$==🔴math==$','\\==🔴escaped==', '==🔴open', '```text\n==🔴code==\n```', '%%==🔴comment==%%']) {
  const html = md.renderResult(source, { noteSyntax: true, noteBlocks: true }).html;
  assert(!html.includes('class="note-highlight"'), source);
}
const html = md.renderResult('# ==🔴Title==\n\n- ==🟠List==\n\n> [!note] ==🟡Title==\n> ==🟢Body==\n\n| ==🔵Cell== |\n| --- |\n| ==🟣Data== |', { noteSyntax: true, noteBlocks: true }).html;
for (const color of ['red','orange','yellow','green','blue','purple']) assert(html.includes('data-hl="'+color+'"'), color);
assert(md.renderResult('{hl:red|old}', { noteSyntax: true }).html.includes('data-hl="red"'));
assert(md.renderResult('==🟤text==', { noteSyntax: true }).html.includes('🟤text'));
assert.equal(md.noteSyntax.highlights('==🔴one====🔵two==').length, 2);
assert.equal(md.noteSyntax.highlights('\\==🔴literal==').length, 0);
assert.equal(md.noteSyntax.highlights('==🔴\uFE0Ftext==')[0].prefix, '🔴\uFE0F');
console.log('note highlight regression: passed');

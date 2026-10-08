'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const context = { window: {} };
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../assets/markdown.js'), 'utf8'), context);
const markdown = context.window.MarkdownMini;
for (const fixture of JSON.parse(fs.readFileSync(path.join(__dirname, 'note-tag-cases.json'), 'utf8'))) {
  assert.deepEqual(Array.from(markdown.tagRanges(fixture.source), (tag) => tag.tag), fixture.inline, fixture.source);
}
const yaml = '---\ntags: [math]\nother: "\\(no\\)"\n---\n#math';
const result = markdown.renderResult(yaml, {localImages:true,noteTags:true});
assert(result.html.includes('note-frontmatter'));
assert.equal(result.features.math, false, 'metadata must not load formula runtime');
assert.equal((result.html.match(/data-note-tag=/g) || []).length, 1);
assert.equal(markdown.renderResult('#math').html.includes('note-tag'), false, 'tag rendering is limited to the note opt-in');
for (const source of ['\\(X\\)', '\\[P(X\\le 74)\\]', '\\[\nx^2\n\\]', '$x$', '$$x$$']) {
  assert.equal(markdown.mathRanges(source).length, 1);
  assert.equal(markdown.renderResult(source).features.math, true);
}
assert.equal(markdown.mathRanges('\\\\(literal\\)').length, 0);
assert.equal(markdown.mathRanges('\\(unclosed').length, 0);
for (const source of ['```\n\\(code\\)', '    \\(code\\)', '`\\(code\\)`', '<!-- \\(comment\\) -->']) {
  assert.equal(markdown.renderResult(source).features.math, false, 'code/comments must not load MathJax');
}
console.log('note tags and delimiters: ok');

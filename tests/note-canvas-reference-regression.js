'use strict';
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const context = { window: {} }; context.window.window = context.window;
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../assets/markdown.js'), 'utf8'), context);
const cases = JSON.parse(fs.readFileSync(path.join(__dirname, 'note-canvas-reference-cases.json'), 'utf8'));
for (const sample of cases) {
  assert.equal(context.window.MarkdownMini.canvasReferences(sample.source).length, sample.count, sample.source);
  assert.equal(context.window.MarkdownMini.rewriteCanvasReferences(sample.source, sample.note, sample.renamed, sample.newNote), sample.expected, sample.source);
}
console.log('note canvas reference regression: ok (' + cases.length + ' shared cases)');

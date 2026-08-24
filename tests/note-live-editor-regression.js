'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

class TextDoc {
  constructor(value) {
    this.value = String(value || '');
    const parts = this.value.split('\n');
    this._lines = [];
    let offset = 0;
    parts.forEach((text, index) => {
      this._lines.push({ number: index + 1, from: offset, to: offset + text.length, length: text.length, text });
      offset += text.length + (index < parts.length - 1 ? 1 : 0);
    });
    this.length = this.value.length;
    this.lines = this._lines.length;
  }
  line(number) { return this._lines[Math.max(0, Math.min(this._lines.length - 1, number - 1))]; }
  lineAt(position) {
    const pos = Math.max(0, Math.min(this.length, Number(position) || 0));
    return this._lines.find((line, index) => pos <= line.to || index === this._lines.length - 1);
  }
  sliceString(from, to) { return this.value.slice(from, to); }
}

class WidgetType {}
function fakeSyntaxTree(state) {
  const doc = state.doc;
  const nodes = [];
  let number = 1;
  while (number <= doc.lines) {
    const line = doc.line(number);
    const fence = /^\s{0,3}(`{3,}|~{3,})\s*([^\s`]*)/.exec(line.text);
    if (fence) {
      let close = number + 1;
      while (close <= doc.lines && !(new RegExp('^\\s{0,3}' + fence[1][0] + '{' + fence[1].length + ',}\\s*$')).test(doc.line(close).text)) close += 1;
      if (close <= doc.lines) nodes.push({ name: 'FencedCode', from: line.from, to: doc.line(close).to });
      number = close <= doc.lines ? close + 1 : doc.lines + 1;
      continue;
    }
    if (/^\s*>/.test(line.text)) {
      let close = number + 1;
      while (close <= doc.lines && /^\s*>/.test(doc.line(close).text)) close += 1;
      nodes.push({ name: 'Blockquote', from: line.from, to: doc.line(close - 1).to });
      number = close; continue;
    }
    if (number < doc.lines && /\|/.test(line.text) && /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(doc.line(number + 1).text)) {
      let close = number + 2;
      while (close <= doc.lines && /\|/.test(doc.line(close).text) && doc.line(close).text.trim()) close += 1;
      nodes.push({ name: 'Table', from: line.from, to: doc.line(close - 1).to });
      number = close; continue;
    }
    if (/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line.text)) nodes.push({ name: 'HorizontalRule', from: line.from, to: line.to });
    if (/^\s*!\[/.test(line.text)) nodes.push({ name: 'Image', from: line.from + line.text.indexOf('!['), to: line.to });
    number += 1;
  }
  return {
    iterate(options) {
      options.enter({ name: 'Document', from: 0, to: doc.length });
      nodes.filter((node) => node.from <= options.to && node.to >= options.from).forEach((node) => options.enter(node));
    },
  };
}
const sandbox = {
  window: {
    RelatumCodeMirror: {
      EditorState: { create: ({ doc }) => ({ doc: new TextDoc(doc) }) },
      EditorSelection: {}, StateEffect: { define: () => ({}) }, StateField: {}, EditorView: {}, Decoration: {}, WidgetType,
      ViewPlugin: {}, keymap: {}, drawSelection() {}, dropCursor() {}, highlightSpecialChars() {},
      rectangularSelection() {}, crosshairCursor() {}, placeholder() {}, highlightActiveLine() {},
      syntaxTree: fakeSyntaxTree, indentOnInput() {},
      bracketMatching() {}, markdown() {}, markdownLanguage: {}, markdownKeymap: [], history() {},
      historyKeymap: [], defaultKeymap: [], indentWithTab: {}, searchKeymap: [], highlightSelectionMatches() {},
    },
  },
  document: {}, console, setTimeout, clearTimeout, requestAnimationFrame() {},
};
sandbox.window.window = sandbox.window;
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'assets', 'note-live-editor.js'), 'utf8'), sandbox);
const editorSource = fs.readFileSync(path.join(__dirname, '..', 'assets', 'note-live-editor.js'), 'utf8');

const syntax = sandbox.window.RelatumNoteLiveSyntax;
assert(syntax, 'Live Preview syntax probe must be exported');

const sample = [
  '| name | value |',
  '| --- | ---: |',
  '| alpha | 42 |',
  '',
  '$$',
  'x^2',
  '$$',
  '',
  '```mermaid',
  'graph TD; A-->B',
  '```',
  '',
  '```derive',
  'a || first',
  '```',
  '',
  '![local](note.assets/images/a.png)',
].join('\n');
const blocks = syntax.scanBlockSpecsFromString(sample);
assert.deepStrictEqual(Array.from(blocks, (block) => block.kind), ['table', 'math', 'mermaid', 'derive', 'image']);
const callout = syntax.scanBlockSpecsFromString('> [!warning]- 只显示标题\n> 这是正文')[0];
assert.strictEqual(callout.kind, 'callout');
assert.strictEqual(callout.collapsed, true);
assert.strictEqual(syntax.parseCalloutSource('> [!unknown]+ 自定义').type, 'unknown');
assert.strictEqual(syntax.scanBlockSpecsFromString('```mermaid\ngraph TD; A-->B').length, 0, 'unclosed fences must remain source');
assert.strictEqual(syntax.scanBlockSpecsFromString('```text\n$$\nx+1\n$$\n```').length, 0, 'custom math must not project inside code fences');
assert.strictEqual(syntax.scanBlockSpecsFromString('$$\nx+1').length, 0, 'unclosed math must remain source');
assert.strictEqual(syntax.scanBlockSpecsFromString('<svg onload="alert(1)"></svg>').length, 0, 'raw HTML/SVG must not become widgets');
assert.strictEqual(syntax.scanBlockSpecsFromString('![remote](https://example.com/a.png)').length, 0, 'remote images must not load');
assert.strictEqual(syntax.parseStandaloneImage('![x](a.assets/images/x.png)').target, 'a.assets/images/x.png');
assert.strictEqual(syntax.parseStandaloneImage('![x](a.assets/images/(nested).png "title")').target, 'a.assets/images/(nested).png');
assert.strictEqual(syntax.isRemoteTarget('javascript:alert(1)'), true);
assert.strictEqual(syntax.isRemoteTarget('data:image/svg+xml,<svg/>'), true);
assert.strictEqual(syntax.isRemoteTarget('//example.com/a.png'), true);
assert.strictEqual(syntax.isRemoteTarget('../safe/local.png'), false);
assert.strictEqual(syntax.isDangerousTarget(' javascript:alert(1)'), true);
assert.strictEqual(syntax.isDangerousTarget('https://example.com'), false);

const headingDoc = new TextDoc('# heading\n###   compact\ntext # closing #');
assert.strictEqual(syntax.headingMarkerProjectionEnd(headingDoc, 0, 1), 2,
  'an inactive ATX heading must hide its marker and separator as one projection range');
assert.strictEqual(syntax.headingMarkerProjectionEnd(headingDoc, 10, 13), 16,
  'all separator whitespace after an opening ATX marker must be hidden');
assert.strictEqual(syntax.headingMarkerProjectionEnd(headingDoc, headingDoc.value.length - 1, headingDoc.value.length), headingDoc.value.length,
  'a closing heading marker must not consume preceding content or unrelated whitespace');

assert.strictEqual(syntax.scanBlockSpecsFromString('$$\n' + 'x'.repeat(32 * 1024) + '\n$$').length, 0,
  'oversized block math must remain source');
assert.strictEqual(syntax.scanBlockSpecsFromString('```mermaid\n' + 'A'.repeat(64 * 1024) + '\n```').length, 0,
  'oversized Mermaid must remain source');
assert.strictEqual(syntax.scanBlockSpecsFromString('```derive\n' + 'A'.repeat(256 * 1024) + '\n```').length, 0,
  'oversized derive blocks must remain source');
assert.strictEqual(syntax.scanBlockSpecsFromString('| a | ' + 'x'.repeat(256 * 1024) + ' |\n| --- | --- |').length, 0,
  'oversized tables must remain source');
assert.strictEqual(syntax.scanBlockSpecsFromString('| a | ' + 'x'.repeat(70 * 1024) + ' |\n| --- | --- |').length, 0,
  'tables containing a line over 64 KiB must remain source');
assert.strictEqual(syntax.scanBlockSpecsFromString('x'.repeat(4 * 1024 * 1024)).length, 0,
  'a 4 MiB long line must scan without becoming a rich component');

assert(!editorSource.includes('defaultHighlightStyle'), 'CodeMirror default heading underline must not be loaded');
assert(!editorSource.includes('syntaxHighlighting('), 'generic CodeMirror highlighting must not override Relatum projection colors');
assert(editorSource.includes('onDocChanged'), 'the editor must report metadata-only document changes');
assert(editorSource.includes('compositionstart') && editorSource.includes('compositionend'), 'explicit IME lifecycle is required');
assert(editorSource.includes('note-live-source-mark'), 'source marker roles must be emitted by Relatum decorations');
assert(editorSource.includes('headingMarkerProjectionEnd'), 'inactive heading markers must include their separator whitespace');

console.log('note live editor regression: ok');

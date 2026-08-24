'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');

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
      syntaxTree: fakeSyntaxTree, forceParsing() { return true; }, indentOnInput() {},
      bracketMatching() {}, closeBrackets() {}, closeBracketsKeymap: [],
      markdown() {}, markdownLanguage: {}, markdownKeymap: [], history() {},
      historyKeymap: [], defaultKeymap: [], indentWithTab: {}, searchKeymap: [], highlightSelectionMatches() {},
      relatumCodeLanguages: [], relatumCodeHighlighting: [],
    },
  },
  document: {}, console, setTimeout, clearTimeout, requestAnimationFrame() {},
};
sandbox.window.window = sandbox.window;
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'assets', 'note-live-editor.js'), 'utf8'), sandbox);
const editorSource = fs.readFileSync(path.join(__dirname, '..', 'assets', 'note-live-editor.js'), 'utf8');
const stylesSource = fs.readFileSync(path.join(__dirname, '..', 'assets', 'styles.css'), 'utf8');
const vendorSource = fs.readFileSync(path.join(__dirname, '..', 'assets', 'vendor', 'codemirror', 'relatum-codemirror.min.js'), 'utf8');
const vendorLock = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'assets', 'vendor', 'codemirror', 'dependency-lock.json'), 'utf8'));
const vendorNotices = fs.readFileSync(path.join(__dirname, '..', 'assets', 'vendor', 'codemirror', 'THIRD_PARTY_NOTICES.md'), 'utf8');
const vendorContext = {};
vm.runInNewContext(vendorSource, vendorContext);
const vendor = vendorContext.RelatumCodeMirror;

function loadLiveDecorationProbe() {
  const context = { console, setTimeout, clearTimeout, requestAnimationFrame() {}, cancelAnimationFrame() {} };
  vm.runInNewContext(vendorSource, context);
  context.window = context;
  context.document = {};
  const instrumented = editorSource.replace(
    'window.RelatumNoteLiveEditor = { create, renderMarkdown };',
    'window.RelatumNoteLiveEditor = { create, renderMarkdown }; window.__relatumLiveTest = { createBlockField, createInlineDecorations, exitEmptyQuoteMarkup };',
  );
  assert.notStrictEqual(instrumented, editorSource, 'the test-only decoration probe must attach to the Live Preview export');
  vm.runInNewContext(instrumented, context);
  return context;
}

function decorationRecords(set, length) {
  const records = [];
  set.between(0, length, (from, to, value) => records.push({ from, to, spec: value.spec }));
  return records;
}

const liveProbe = loadLiveDecorationProbe();
function runEmptyQuoteExit(source, cursor = source.length) {
  let state = liveProbe.RelatumCodeMirror.EditorState.create({
    doc: source,
    selection: { anchor: cursor },
  });
  const view = {
    get state() { return state; },
    dispatch(spec) { state = state.update(spec).state; },
  };
  const handled = liveProbe.__relatumLiveTest.exitEmptyQuoteMarkup(view);
  return { handled, state };
}

const calloutExit = runEmptyQuoteExit('> [!example] Example\n> ');
assert.strictEqual(calloutExit.handled, true, 'a second Enter on an empty callout quote line must be handled');
assert.strictEqual(calloutExit.state.doc.toString(), '> [!example] Example\n', 'the empty quote marker must be removed immediately');
assert.strictEqual(calloutExit.state.selection.main.head, calloutExit.state.doc.length);
const nestedQuoteExit = runEmptyQuoteExit('> > ');
assert.strictEqual(nestedQuoteExit.handled, true, 'nested empty quotes must exit one level at a time');
assert.strictEqual(nestedQuoteExit.state.doc.toString(), '> ');
assert.strictEqual(runEmptyQuoteExit('> body').handled, false, 'non-empty quotes must keep the Markdown continuation behavior');
assert.strictEqual(runEmptyQuoteExit('- ').handled, false, 'list continuation must not be intercepted');

const segmentedSource = [
  '当自增运算符出现在表达式中，前缀和后缀的执行时机不同。',
  '',
  '| 形式 | 执行逻辑 | 表达式结果 | 变量最终值 |',
  '| --- | --- | --- | --- |',
  '| 前缀自增 `++c` | 先让 x 加 1 | 加 1 后的新值 | 原 value +1 |',
  '| 后缀自增 `c++` | 先使用 x 当前值 | 加 1 前的原始值 | 原 value +1 |',
  '',
  '#### 示例 1：赋值表达式中',
  '',
  '```c',
  'int a = 5, b = 5;',
  'int c, d;',
  '```',
].join('\n');
const coordinator = { field: null, spec() { return null; } };
const probeOptions = { coordinator, imageUrl() { return ''; } };
const blockField = liveProbe.__relatumLiveTest.createBlockField(() => 'segmented.md', probeOptions, coordinator);
const segmentedState = liveProbe.RelatumCodeMirror.EditorState.create({
  doc: segmentedSource,
  extensions: [
    liveProbe.RelatumCodeMirror.markdown({
      base: liveProbe.RelatumCodeMirror.markdownLanguage,
      codeLanguages: liveProbe.RelatumCodeMirror.relatumCodeLanguages,
    }),
    blockField,
  ],
});
const tableSpec = segmentedState.field(blockField).specs.find((spec) => spec.kind === 'table');
assert(tableSpec, 'the segmented regression fixture must project its table');
const segmentedView = {
  state: segmentedState,
  visibleRanges: [{ from: 0, to: tableSpec.from }, { from: tableSpec.to, to: segmentedState.doc.length }],
  composing: false,
  __relatumCompositionActive: false,
  hasFocus: false,
};
const segmentedDecorations = decorationRecords(
  liveProbe.__relatumLiveTest.createInlineDecorations(segmentedView, blockField, () => 'segmented.md', probeOptions),
  segmentedState.doc.length,
);
const segmentedHeading = segmentedState.doc.lineAt(segmentedSource.indexOf('#### 示例 1')).from;
const openingFence = segmentedSource.indexOf('```c');
const closingFence = segmentedSource.lastIndexOf('```');
assert(segmentedDecorations.some((item) => item.from === segmentedHeading
  && /(?:^|\s)note-live-heading(?:\s|$)/.test(item.spec.class || '')),
  'a table replacement must not suppress heading projection in the following visible range');
assert(segmentedDecorations.some((item) => item.from === openingFence && item.to === openingFence + 3 && !item.spec.class),
  'a table replacement must not leave the following opening code fence visible');
assert(segmentedDecorations.some((item) => item.from === closingFence && item.to === closingFence + 3 && !item.spec.class),
  'a table replacement must not leave the following closing code fence visible');

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
assert.strictEqual(syntax.scanBlockSpecsFromString('$$x^2+1$$')[0].kind, 'math', 'same-line $$ math must become a display block');
assert.strictEqual(syntax.scanBlockSpecsFromString('$x^2+1$').length, 0, 'inline math must not become a display block');
assert.strictEqual(syntax.scanBlockSpecsFromString('before $$x^2+1$$').length, 0, 'display math delimiters must own the trimmed line');
assert.strictEqual(syntax.scanBlockSpecsFromString('```text\n$$x^2+1$$\n```').length, 0, 'same-line display math must not project inside code fences');
assert.strictEqual(syntax.scanBlockSpecsFromString('$$x\\$$').length, 0, 'an escaped closing delimiter must remain source');
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
assert(editorSource.includes('relatumCodeLanguages') && editorSource.includes('relatumCodeHighlighting'), 'fenced code must use the scoped offline language pack');
assert(editorSource.includes('forceParsing') && editorSource.includes('viewportScanEffect'), 'long documents must refresh the syntax tree and visible rich blocks');
assert(editorSource.includes('viewportParseRequestEffect') && editorSource.includes("addEventListener('scroll', this.onScroll"),
  'restored and programmatic scrolling must explicitly refresh visible decorations');
assert(editorSource.includes('ResizeObserver') && editorSource.includes("removeEventListener('scroll', this.onScroll)"),
  'layout-driven viewport refresh hooks must be installed and cleaned up');
assert(editorSource.includes('range.from - BLOCK_MATH_LIMIT') && editorSource.includes('range.to + BLOCK_MATH_LIMIT'),
  'nearby rich blocks must be discovered before their widgets change restored viewport geometry');
assert(editorSource.includes('tree.resolveInner(clamp(position') && editorSource.includes('visibleFirst = Math.max(first.number, blockFirst)'),
  'a viewport beginning inside a fence must retain code block line decorations');
assert(editorSource.includes('onDocChanged'), 'the editor must report metadata-only document changes');
assert(editorSource.includes('function renderMarkdown(host, source, notePath, options)'),
  'reading mode must reuse the safe Markdown renderer and authorized local image path');
assert(editorSource.includes('compositionstart') && editorSource.includes('compositionend'), 'explicit IME lifecycle is required');
assert(editorSource.includes('note-live-source-mark'), 'source marker roles must be emitted by Relatum decorations');
assert(editorSource.includes('headingMarkerProjectionEnd'), 'inactive heading markers must include their separator whitespace');
assert(stylesSource.includes('.cm-line.note-live-code-line.cm-activeLine'), 'the active code line must retain its block background');
assert(stylesSource.includes('note-live-code-first') && stylesSource.includes('note-live-code-last'), 'code block corners must use explicit first/last line roles');
assert(vendor && typeof vendor.forceParsing === 'function', 'the offline CodeMirror bundle must expose forceParsing');
assert.strictEqual(typeof vendor.closeBrackets, 'function', 'the offline CodeMirror bundle must expose native bracket pairing');
assert(Array.isArray(vendor.closeBracketsKeymap) && vendor.closeBracketsKeymap.some((binding) => binding.key === 'Backspace'),
  'the offline CodeMirror bundle must expose paired Backspace handling');
assert(editorSource.indexOf('Array.isArray(closeBracketsKeymap)') < editorSource.indexOf('markdownKeymap, defaultKeymap'),
  'paired Backspace must run before generic Markdown and character deletion');
assert(vendor.relatumCodeHighlighting && vendor.relatumCodeLanguages.some((language) => language.name === 'C'), 'the offline CodeMirror bundle must include scoped code highlighting and C support');

const fence = '`'.repeat(3);
function nestedCodeNode(language, code) {
  const doc = fence + language + '\n' + code + '\n' + fence;
  const state = vendor.EditorState.create({
    doc,
    extensions: [
      vendor.markdown({ base: vendor.markdownLanguage, codeLanguages: vendor.relatumCodeLanguages }),
      vendor.relatumCodeHighlighting,
    ],
  });
  return vendor.syntaxTree(state).resolveInner(doc.indexOf(code) + Math.min(2, code.length), 1).name;
}
assert.notStrictEqual(nestedCodeNode('c', 'int main(void) { return 0; }'), 'CodeText', 'C fences must mount the offline C/C++ parser');
assert.notStrictEqual(nestedCodeNode('python', 'def greet(name):\n    return name'), 'CodeText', 'Python fences must mount the offline Python parser');
assert.notStrictEqual(nestedCodeNode('powershell', '$value = Get-Item .'), 'CodeText', 'PowerShell fences must mount the offline stream parser');
assert.strictEqual(nestedCodeNode('unknown-language', 'plain source'), 'CodeText', 'unknown fence languages must safely remain plain code');
const directVendorDependencies = vendorLock.packages[''].dependencies;
assert.strictEqual(directVendorDependencies['@codemirror/lang-cpp'], '6.0.3');
assert.strictEqual(directVendorDependencies['@codemirror/lang-python'], '6.2.1');
assert.strictEqual(directVendorDependencies['@codemirror/legacy-modes'], '6.5.3');
assert.strictEqual(directVendorDependencies['@codemirror/autocomplete'], '6.20.3');
const vendorHash = crypto.createHash('sha256').update(vendorSource).digest('hex').toUpperCase();
assert(vendorNotices.includes(vendorHash), 'the checked-in CodeMirror SHA-256 must match its vendor notice');

console.log('note live editor regression: ok');

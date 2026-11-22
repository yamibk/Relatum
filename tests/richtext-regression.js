'use strict';

const assert = require('node:assert/strict');

function text(value) {
  return { nodeType: 3, nodeName: '#text', nodeValue: value, parentElement: null };
}

function element(tagName, children, dataset, innerText) {
  const el = {
    nodeType: 1,
    nodeName: String(tagName || 'div').toUpperCase(),
    tagName: String(tagName || 'div').toUpperCase(),
    dataset: dataset || {},
    childNodes: children || [],
    parentElement: null,
  };
  el.childNodes.forEach(function (child) { child.parentElement = el; });
  if (innerText !== undefined) el.innerText = innerText;
  return el;
}

require('../assets/richtext.js');
const RichText = global.RelatumRichText;

function extract(root) {
  return RichText.extractEditable(root);
}

// Enter may arrive as a carriage return text node. Persist one canonical \n.
{
  const root = element('div', [text('123\r456')], {}, '123\r456');
  assert.deepEqual(extract(root), { text: '123\n456', marks: [] });
}

// Browser-created block lines must not throw and must retain their visible boundary.
{
  const secondLine = element('div', [text('456')]);
  const root = element('div', [text('123'), secondLine], {}, '123\n456');
  assert.deepEqual(extract(root), { text: '123\n456', marks: [] });
}

// An inline <br> contributes a visible line break even though it has no text node.
{
  const root = element('div', [text('123'), element('br'), text('456')], {}, '123\n456');
  assert.deepEqual(extract(root), { text: '123\n456', marks: [] });
}

// A blank DIV uses a caret BR. Chromium's innerText counts both as breaks.
{
  const marked = text('456');
  const line = element('div', [element('span', [marked], { rtBold: '1' })]);
  const root = element('div', [text('123'), element('div', [element('br')]), line], {}, '123\n\n\n456');
  assert.deepEqual(extract(root), { text: '123\n\n456', marks: [{ start: 5, end: 8, bold: true }] });
  assert.equal(RichText.editableOffset(root, marked, 1), 6);
}

// A block can follow an existing LF and a BR, both of which occupy one line boundary.
{
  const root = element('div', [text('123\n'), element('br'), element('div', [text('456')])]);
  assert.deepEqual(extract(root), { text: '123\n\n456', marks: [] });
}

// Rich runs on either side of a generated line break keep correct offsets and palettes.
{
  const first = element('span', [text('same')], { rtBold: '1' });
  const second = element('span', [text('same')], { rtColor: 'red', rtHighlight: 'yellow' });
  const block = element('div', [second]);
  const root = element('div', [first, block], {}, 'same\nsame');
  assert.deepEqual(extract(root), {
    text: 'same\nsame',
    marks: [
      { start: 0, end: 4, bold: true },
      { start: 5, end: 9, color: 'red', highlight: 'yellow' },
    ],
  });
}

// Hidden editable descendants must not shift their style onto visible content.
{
  const hidden = element('span', [text('hidden')], { rtColor: 'red' });
  hidden.hidden = true;
  const visible = element('span', [text('visible')], { rtBold: '1' });
  const root = element('div', [hidden, visible], {}, 'visible');
  assert.deepEqual(extract(root), {
    text: 'visible',
    marks: [{ start: 0, end: 7, bold: true }],
  });
}

// The marker pass sees the same logical lines as commit, including browser-only breaks.
{
  const first = text('# Heading');
  const second = text('## Next\r\n### Last');
  const root = element('div', [first, element('br'), element('div', [element('span', [second])])]);
  const source = RichText.editableSource(root);
  assert.equal(source.text, '# Heading\n## Next\n### Last');
  assert.deepEqual(source.segments, [
    { node: first, start: 0, end: 9, domStart: 0 },
    { node: second, start: 10, end: 17, domStart: 0 },
    { node: second, start: 18, end: 26, domStart: 9 },
  ]);
}

// Structured formatting follows retained characters when Markdown delimiters are removed.
{
  const source = '==before== {';
  const marks = RichText.apply(source, [], 11, 12, { highlight: 'yellow' });
  const parsed = RichText.parseLegacy(source, marks);
  assert.equal(parsed.text, 'before {');
  assert.deepEqual(parsed.marks, [
    { start: 0, end: 6, highlight: 'yellow' },
    { start: 7, end: 8, highlight: 'yellow', highlightTag: true },
  ]);
  assert.equal(RichText.serialize('Yellow', RichText.apply('Yellow', [], 0, 6, { highlight: 'yellow' })), '==Yellow==');
  assert.deepEqual(RichText.parseLegacy('{hl:yellow|a==b==c}').marks, [
    { start: 0, end: 1, highlight: 'yellow', highlightTag: true },
    { start: 1, end: 2, highlight: 'yellow' },
    { start: 2, end: 3, highlight: 'yellow', highlightTag: true },
  ]);
  assert.deepEqual(RichText.parseLegacy('==abc==', [{ start: 3, end: 4, highlight: 'blue', bold: true }]).marks, [
    { start: 0, end: 1, highlight: 'yellow' },
    { start: 1, end: 2, highlight: 'blue', bold: true },
    { start: 2, end: 3, highlight: 'yellow' },
  ]);
}

console.log('richtext regression tests passed');

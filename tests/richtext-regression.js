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

console.log('richtext regression tests passed');

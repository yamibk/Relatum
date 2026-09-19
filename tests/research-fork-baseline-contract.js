'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const read = (name) => fs.readFileSync(path.join(root, name), 'utf8');
const startHtml = read('assets/index.html');
const editorHtml = read('assets/editor.html');
const editor = read('assets/editor.js');
const canvas = read('assets/canvas.js');
const editorLazy = read('assets/editor-lazy.js');

assert(
  !/<(?:script|link)\b[^>]+(?:src|href)=["'][^"']*research/i.test(startHtml),
  'Research scripts and styles must stay off the start-page critical path',
);
assert(
  !/<iframe\b[^>]+(?:src=["'][^"']*research|data-research)/i.test(startHtml),
  'the Research iframe must be created lazily instead of shipping in the initial DOM',
);

const originalEditorSources = [editorHtml, editor, canvas, editorLazy].join('\n');
[
  'assets/research/',
  'research.html',
  'RelatumResearch',
].forEach((needle) => {
  assert(
    !originalEditorSources.includes(needle),
    'the original editor must not depend on the Research fork: ' + needle,
  );
});

const scriptOrder = [
  'i18n.js',
  'desktop-shell.js',
  'sticky-palette.js',
  'mermaid-renderer.js',
  'richtext.js',
  'markdown-table.js',
  'markdown.js',
  'table-editor.js',
  'ruler.js',
  'canvas-import.js',
  'node-matrix.js',
  'canvas-timer.js',
  'markdown-notebook.js',
  'canvas-scenes.js',
  'canvas-taskbook.js',
  'ai-canvas-plan.js',
  'dual-clipboard.js',
  'font-loader.js',
  'canvas-changes.js',
  'canvas.js',
  'editor-lazy.js',
  'editor.js',
];

let previousIndex = -1;
scriptOrder.forEach((source) => {
  const marker = '<script src="' + source + '" defer></script>';
  const index = editorHtml.indexOf(marker);
  assert(index >= 0, 'missing original editor dependency: ' + source);
  assert(index > previousIndex, 'original editor dependency order changed at: ' + source);
  previousIndex = index;
});
assert(
  previousIndex < editorHtml.indexOf('</head>'),
  'the original editor dependency chain must remain discoverable from the document head',
);

console.log('research fork baseline contract passed');

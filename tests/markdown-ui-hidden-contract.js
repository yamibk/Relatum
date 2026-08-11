'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const read = (name) => fs.readFileSync(path.join(root, name), 'utf8');
const indexHtml = read('assets/index.html');
const editorHtml = read('assets/editor.html');
const start = read('assets/start.js');
const editor = read('assets/editor.js');
const styles = read('assets/styles.css');
const app = read('app.py');

assert(!indexHtml.includes('data-action="import-md"'),
  'the start page must not render a Markdown import button');
assert(!editorHtml.includes('data-action="export-md"'),
  'the editor must not render a Markdown export button');
assert(styles.includes('[data-action="import-md"]')
  && styles.includes('[data-action="export-md"]')
  && styles.includes('display: none !important;'),
  'CSS must keep stale Markdown UI fragments hidden after merges');
assert(!start.includes("['导入 MD',"),
  'start help must not advertise the hidden Markdown importer');
assert(!editorHtml.includes('导出 Markdown 或 PNG 图片'),
  'editor help must not advertise the hidden Markdown exporter');

assert(start.includes("fetch('/api/import-markdown'"),
  'the dormant Markdown import implementation must remain available');
assert(editor.includes("fetch('/api/export-markdown'"),
  'the dormant Markdown export implementation must remain available');
assert(app.includes('"/api/import-markdown"') && app.includes('"/api/export-markdown"'),
  'the dormant Markdown backend routes must remain available');

console.log('markdown UI hidden contract passed');

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const read = (name) => fs.readFileSync(path.join(root, name), 'utf8');
const canvas = read('assets/canvas.js');
const editor = read('assets/editor.js');
const ai = read('assets/ai.js');
const calendar = read('assets/calendar.js');
const review = read('assets/review.js');
const css = read('assets/styles.css');

[canvas, editor, ai, calendar, review].forEach((source, index) => {
  assert(source.includes('renderResult('), `Markdown consumer ${index} must reuse renderResult()`);
});

[canvas, editor, ai, calendar, review].forEach((source, index) => {
  assert(
    source.includes('features.math') || source.includes('scanFeatures'),
    `Markdown consumer ${index} must gate math work by source features`,
  );
});

[canvas, editor, ai, calendar, review].forEach((source, index) => {
  assert(
    source.includes('features.mermaid') || source.includes('scanFeatures'),
    `Markdown consumer ${index} must gate Mermaid work by source features`,
  );
});

for (let level = 1; level <= 6; level++) {
  assert(css.includes(`.node-text h${level}`), `compact Markdown CSS must include h${level}`);
  assert(css.includes(`.text-reader-content h${level}`), `reader CSS must include h${level}`);
  assert(css.includes(`.review-body h${level}`), `review CSS must include h${level}`);
  assert(css.includes(`.ai-bubble h${level}`), `AI CSS must include h${level}`);
  assert(css.includes(`.calendar-diary-preview h${level}`), `calendar CSS must include h${level}`);
}

assert(css.includes('.markdown-notebook-preview.node-text'),
  'Notebook must opt into the full document heading scale');
assert(css.includes('.md-reader-content .attach-md-body.node-text'),
  'Markdown attachments must opt into the full document heading scale');

console.log('global Markdown contract: ok');

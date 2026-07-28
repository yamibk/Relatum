const fs = require('fs');
const path = require('path');
const vm = require('vm');

global.window = global;
global.MarkdownTable = null;
vm.runInThisContext(
  fs.readFileSync(path.join(__dirname, '..', 'assets', 'markdown.js'), 'utf8'),
  { filename: 'markdown.js' },
);

const screenshotInput = '# 123\n## 123\n### 123\n#### 1234\n# 1\n\n- 123321\n- ';
const screenshotResult = global.MarkdownMini.renderResult(screenshotInput);
if (screenshotResult.error || !screenshotResult.html.includes('- ')) {
  throw new Error('screenshot regression input did not degrade safely');
}

const emptyMarkerStress = global.MarkdownMini.renderResult(
  Array.from({ length: 5000 }, () => '- ').join('\n'),
);
if (emptyMarkerStress.error || emptyMarkerStress.html.length > 1_000_000) {
  throw new Error('empty marker stress input did not remain bounded');
}

let seed = 0x5eed1234;
function random() {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return seed / 0x100000000;
}

const atoms = [
  '', '-', '- ', '* ', '+ ', '1. ', '1) ', '# ', '###### ',
  '> ', '```', '~~~', '$$', '$', '\\', '[', ']', '<b>', '| --- |',
  '- [ ] ', '- [x] ', '普通文本', '**', '__', '[[', ']]', '\t- ',
];
for (let sample = 0; sample < 1800; sample++) {
  const lineCount = 1 + Math.floor(random() * 22);
  const lines = [];
  for (let line = 0; line < lineCount; line++) {
    let value = '';
    const atomCount = 1 + Math.floor(random() * 7);
    for (let atom = 0; atom < atomCount; atom++) {
      value += atoms[Math.floor(random() * atoms.length)];
    }
    lines.push(value);
  }
  const result = global.MarkdownMini.renderResult(lines.join('\n'));
  if (!result || typeof result.html !== 'string' || result.html.length > 2_000_000) {
    throw new Error(`invalid render result at sample ${sample}`);
  }
}

console.log('markdown fuzz worker: ok');

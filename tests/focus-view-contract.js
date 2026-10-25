'use strict';
// Standalone task/timer assets must each be self-contained on first use.
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const read = file => fs.readFileSync(path.join(__dirname, '../assets', file), 'utf8');
const base = read('styles.css');
for (const page of ['tasks', 'focus']) {
  const css = read('daily-' + page + '.css');
  const animations = new Set([...css.matchAll(/animation:\s*([-\w]+)/g)].map(match => match[1]).filter(name => name !== 'none'));
  const keyframes = new Set([...(base + css).matchAll(/@keyframes\s+([-\w]+)/g)].map(match => match[1]));
  for (const name of animations) assert(keyframes.has(name), page + ': missing independent animation ' + name);
}
assert(!read('index.html').includes('preloadJson(\'/api/daily\')'));
assert(!read('index.html').includes('data-role="focus-timer-view"'));
assert(read('daily-tasks.html').includes('data-role="focus-daily-list"'));
assert(read('daily-focus.html').includes('data-role="focus-timer-view"'));
require('./daily-focus-service');

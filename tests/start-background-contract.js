const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'assets', 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(root, 'assets', 'styles.css'), 'utf8');
const start = fs.readFileSync(path.join(root, 'assets', 'start.js'), 'utf8');

assert(html.includes('class="start-ambient"'),
  'the start page must expose one shared ambient background container');
assert((html.match(/start-ambient-layer start-ambient-layer-[abcde]/g) || []).length === 5,
  'the immersive start background must contain exactly five flow layers');
assert(html.includes('class="start-ambient-wash"'),
  'the immersive start background must retain a dedicated readability wash');
assert(!html.includes('start-sky') && !html.includes('sky-photo') && !html.includes('sky-scrim'),
  'the start page must not retain the legacy photo background DOM');

const ambientStart = css.indexOf('/* ─── 起步页 · 程序化沉浸流场');
const ambientEnd = css.indexOf('/* 顶栏：亚克力毛玻璃', ambientStart);
assert(ambientStart >= 0 && ambientEnd > ambientStart,
  'the procedural immersive background section must remain identifiable');
const ambientCss = css.slice(ambientStart, ambientEnd);

assert(ambientCss.includes('startAmbientFlowA 28s')
  && ambientCss.includes('startAmbientFlowB 34s')
  && ambientCss.includes('startAmbientFlowC 41s')
  && ambientCss.includes('startAmbientFlowD 31s')
  && ambientCss.includes('startAmbientFlowE 47s'),
  'the five ambient layers must retain their distinct 28–47 second rhythms');
assert((ambientCss.match(/radial-gradient\(/g) || []).length >= 36,
  'the ambient flow must stay split into many overlapping small glows');
assert(ambientCss.includes('opacity 560ms cubic-bezier(0.22, 1, 0.36, 1)'),
  'switching immersive mode must keep a soft, finite opacity transition');
assert(ambientCss.includes('[data-start-background="scenic"] .start-ambient-layer')
  && ambientCss.includes('animation-play-state: running'),
  'only scenic mode may run the ambient animation layers');
assert(ambientCss.includes('.start-ambient-layer { animation-play-state: paused; }'),
  'ambient animation layers must stay paused outside scenic mode');
assert(ambientCss.includes('@media (prefers-reduced-motion: reduce)')
  && ambientCss.includes('animation: none !important')
  && ambientCss.includes('will-change: auto !important'),
  'reduced-motion mode must render a static ambient scene without compositor hints');
assert(!ambientCss.includes('sky-dark.png') && !ambientCss.includes('start-sky'),
  'the start-page ambient section must not depend on the legacy aurora photo');

const layerBlock = (name, nextName) => {
  const from = ambientCss.indexOf(`.start-ambient-layer-${name} {`);
  const to = ambientCss.indexOf(`.start-ambient-layer-${nextName} {`, from);
  return ambientCss.slice(from, to);
};
const purpleRegion = layerBlock('a', 'b');
const blueRegion = layerBlock('b', 'c');
const mintRegion = layerBlock('c', 'd');
const pinkRegion = layerBlock('d', 'e');
assert(purpleRegion.includes('var(--start-ambient-purple)')
  && !purpleRegion.includes('var(--start-ambient-blue')
  && !purpleRegion.includes('var(--start-ambient-pink')
  && !purpleRegion.includes('var(--start-ambient-mint'),
  'the upper-left flow layer must remain a dedicated purple region');
assert(blueRegion.includes('var(--start-ambient-blue)')
  && !blueRegion.includes('var(--start-ambient-purple')
  && !blueRegion.includes('var(--start-ambient-pink')
  && !blueRegion.includes('var(--start-ambient-mint'),
  'the upper-right flow layer must remain a dedicated blue region');
assert(mintRegion.includes('var(--start-ambient-mint)')
  && !mintRegion.includes('var(--start-ambient-purple')
  && !mintRegion.includes('var(--start-ambient-blue')
  && !mintRegion.includes('var(--start-ambient-pink'),
  'the lower-left flow layer must remain a dedicated mint region');
assert(pinkRegion.includes('var(--start-ambient-pink)')
  && !pinkRegion.includes('var(--start-ambient-purple')
  && !pinkRegion.includes('var(--start-ambient-blue')
  && !pinkRegion.includes('var(--start-ambient-mint'),
  'the lower-right flow layer must remain a dedicated pink region');

assert(css.includes('body.start-page[data-start-theme="dark"] {')
  && css.includes('--start-ambient-purple: rgba(150, 130, 205, 0.34)')
  && css.includes('--start-ambient-mint: rgba(82, 157, 136, 0.28)'),
  'dark mode must theme the shared flow geometry through ambient color variables');
assert(!css.includes('body.start-page[data-start-theme="dark"][data-start-state]::before')
  && !css.includes('body.start-page[data-start-theme="dark"][data-start-state]::after'),
  'dark mode must not replace the shared ambient geometry with theme-specific layers');

assert(start.includes("const START_BACKGROUND_KEY = 'canvas:startBackgroundStyle';")
  && start.includes("style === 'scenic' ? 'scenic' : 'simple'")
  && start.includes('localStorage.setItem(START_BACKGROUND_KEY, startBackgroundStyle)'),
  'the existing simple/scenic preference key and values must remain compatible');

console.log('start background contract passed');

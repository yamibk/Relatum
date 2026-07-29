const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'assets', 'editor.html'), 'utf8');
const editor = fs.readFileSync(path.join(root, 'assets', 'editor.js'), 'utf8');
const canvas = fs.readFileSync(path.join(root, 'assets', 'canvas.js'), 'utf8');
const i18n = fs.readFileSync(path.join(root, 'assets', 'i18n.js'), 'utf8');
const styles = fs.readFileSync(path.join(root, 'assets', 'styles.css'), 'utf8');

const cleanCurveStart = html.indexOf(
  '<div class="sp-shape-switch sp-multi" data-role="clean-curve">'
);
assert(cleanCurveStart >= 0, 'clean curve control must use the multi-row switch');
const cleanCurveEnd = html.indexOf('</div>', cleanCurveStart);
assert(cleanCurveEnd > cleanCurveStart, 'clean curve control must have a closing tag');
const cleanCurveBlock = html.slice(cleanCurveStart, cleanCurveEnd);

const buttons = Array.from(cleanCurveBlock.matchAll(
  /<button[^>]+data-curve="([^"]+)"[^>]*>([^<]+)<\/button>/g
)).map((match) => [match[1], match[2].trim()]);
assert.deepStrictEqual(buttons, [
  ['bezier', '曲线'],
  ['branch', '枝桠曲线'],
  ['s-curve', 'S 曲线'],
  ['rounded-elbow', '圆角折线'],
  ['straight', '直线'],
  ['organic', '自然曲线'],
], 'clean mode must expose exactly the intended six curve options in the compact layout order');

assert(
  /\.sp-shape-switch\.sp-multi\s*\{[\s\S]*?display:\s*grid;/.test(styles),
  'multi-row curve switches must use grid layout'
);
assert(
  /\.clean-style-panel \.sp-shape-switch\s*\{\s*grid-template-columns:\s*repeat\(3, minmax\(0, 1fr\)\);/.test(styles),
  'clean style switches must keep the three-column layout'
);

const edgeCurvesMatch = canvas.match(/const EDGE_CURVES = \[([^\]]+)\]/);
assert(edgeCurvesMatch, 'canvas must declare supported edge curves');
const supportedCurves = Array.from(edgeCurvesMatch[1].matchAll(/'([^']+)'/g), (match) => match[1]);
buttons.forEach(([curve]) => {
  assert(supportedCurves.includes(curve), 'clean curve must be supported by canvas geometry: ' + curve);
});

const panelStart = editor.indexOf('(function setupCleanStylePanel()');
const panelEnd = editor.indexOf('\n  })();', panelStart);
assert(panelStart >= 0 && panelEnd > panelStart, 'missing clean style panel implementation');
const panelBlock = editor.slice(panelStart, panelEnd);
[
  "panel.querySelectorAll('[data-role=\"clean-curve\"] button')",
  "if (button.dataset.curve === 'bezier') delete g.curve; else g.curve = button.dataset.curve;",
  'writeEdge();',
].forEach((needle) => {
  assert(panelBlock.includes(needle), 'missing clean curve persistence contract: ' + needle);
});

[
  "'S 曲线': 'S curve'",
  "'枝桠曲线': 'Branch curve'",
  "'自然曲线': 'Organic curve'",
].forEach((needle) => {
  assert(i18n.includes(needle), 'missing clean curve translation: ' + needle);
});

console.log('clean style curve contract: ok');

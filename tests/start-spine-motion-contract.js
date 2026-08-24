'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const start = fs.readFileSync(path.join(root, 'assets', 'start.js'), 'utf8');
const styles = fs.readFileSync(path.join(root, 'assets', 'styles.css'), 'utf8');
const html = fs.readFileSync(path.join(root, 'assets', 'index.html'), 'utf8');

function functionSource(name, nextName) {
  const from = start.indexOf('function ' + name + '(');
  const to = start.indexOf('function ' + nextName + '(', from + 1);
  assert(from >= 0 && to > from, 'missing function boundary for ' + name);
  return start.slice(from, to);
}

assert(html.includes('data-role="spine-active-orb"'));
assert(html.includes('data-role="spine-hover-rail"'));
assert(html.includes('data-role="spine-hover-orb"'));

const clearHover = functionSource('clearSpineHover', 'scheduleSpineBreathe');
assert(clearHover.includes('returnSpineHover(options)'));
assert(!clearHover.includes("classList.remove('spine-hovering'"), 'pointer leave must return instead of hide');
assert(start.includes("spineEl.addEventListener('pointerleave', clearSpineHover)"));
assert(start.includes("setSpineMarkerState(spine, 'resting', active)"));
assert(start.includes("placeSpineHover(active, { state, animate })"));
assert(start.includes("spineMarkerSettleTimer = window.setTimeout(() => finishSpineMarkerReturn(key), 360)"));

assert(start.includes("spine.classList.add('spine-marker-no-transition')"));
assert(start.includes("if (animate && spineMarkerReady && spine.classList.contains('spine-marker-visible')) return"));
assert(styles.includes('.left-spine.spine-marker-no-transition .spine-hover-rail'));
assert(styles.includes('.left-spine.spine-marker-no-transition .spine-hover-orb { transition: none; }'));

assert(start.includes('bindSpineHoverTarget(dot)'));
assert(start.includes('requestAnimationFrame(syncActiveSpineOrb)'));
assert(start.includes('syncCanvasWorkspaceSpineAfterReveal()'), 'revealing Canvas must remeasure its previously hidden spine');
assert(start.includes("if (activeStartWorkspace !== 'canvas') return;\n      syncActiveSpineOrb({ animate: false });"), 'hidden-workspace geometry must never survive a Canvas reveal');
assert(start.includes('spinePreviewTarget && spinePreviewTarget.isConnected'));
assert(start.includes('hideSpineMarker();'));

assert(styles.includes('.left-spine.spine-marker-visible .spine-hover-rail { opacity: 0.72; }'));
assert(styles.includes('.left-spine.spine-marker-visible .spine-hover-orb { opacity: 0.46; }'));
assert(styles.includes('.left-spine.spine-marker-previewing .spine-hover-orb { opacity: 0.78; }'));
assert(styles.includes('.left-spine.spine-marker-returning .spine-hover-orb { opacity: 0.58; }'));
assert(styles.includes('.left-spine.spine-hover-current .spine-hover-orb'));

assert(start.includes("window.matchMedia('(prefers-reduced-motion: reduce)').matches"));
assert(/@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.spine-hover-rail,[\s\S]*?\.spine-hover-orb \{ transition: none; \}/.test(styles));

console.log('start spine motion contract passed');

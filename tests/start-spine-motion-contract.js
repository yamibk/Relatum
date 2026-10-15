'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const start = fs.readFileSync(path.join(root, 'assets', 'start.js'), 'utf8');
const styles = fs.readFileSync(path.join(root, 'assets', 'styles.css'), 'utf8');
const html = fs.readFileSync(path.join(root, 'assets', 'index.html'), 'utf8');

assert(html.includes('data-role="spine-active-orb"'));
assert(html.includes('data-role="spine-hover-rail"'));
assert(html.includes('data-role="spine-hover-orb"'));

// The browser suite checks scheduling, cancellation and reuse by behavior. This
// contract only locks the shared DOM/CSS and existing user preference boundaries.
assert(styles.includes('.left-spine.spine-marker-no-transition .spine-active-orb,'));
assert(styles.includes('.left-spine.spine-marker-no-transition .spine-hover-rail'));
assert(styles.includes('.left-spine.spine-marker-no-transition .spine-hover-orb { transition: none; }'));
assert(!styles.slice(styles.indexOf('.spine-hover-orb {'), styles.indexOf('.left-spine.spine-marker-no-transition')).includes('border-width 180ms'));
assert(styles.includes('.left-spine.spine-motion-suspended :is(.spine-active-orb, .spine-hover-rail, .spine-hover-orb)'));

assert(styles.includes('.left-spine.spine-marker-visible .spine-hover-rail { opacity: 0.72; }'));
assert(styles.includes('.left-spine.spine-marker-visible .spine-hover-orb { opacity: 0.46; }'));
assert(styles.includes('.left-spine.spine-marker-previewing .spine-hover-orb { opacity: 0.78; }'));
assert(styles.includes('.left-spine.spine-marker-returning .spine-hover-orb { opacity: 0.58; }'));
assert(styles.includes('.left-spine.spine-hover-current .spine-hover-orb'));

assert(start.includes("const SPINE_SPEED_KEY = 'canvas:spineMotionMs:v1'"));
assert(start.includes('const SPINE_SPEED_DEFAULT = 414'));
assert(start.includes('const SPINE_SPEED_MIN = 100'));
assert(start.includes('const SPINE_SPEED_MAX = 800'));
assert(/@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.spine-hover-rail,[\s\S]*?\.spine-hover-orb \{ transition: none; \}/.test(styles));

console.log('start spine motion contract passed');

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const shell = fs.readFileSync(path.join(root, 'assets', 'desktop-shell.js'), 'utf8');
const desktop = fs.readFileSync(path.join(root, 'desktop.py'), 'utf8');

assert(shell.includes("bar.classList.toggle('pywebview-drag-region', !maximized)"));
assert(shell.includes("window.addEventListener('canvasdesktop:window-state'"));
assert(desktop.includes('WM_WINDOWPOSCHANGING = 0x0046'));
assert(desktop.includes('PYWEBVIEW_MOVE_FLAGS = SWP_NOSIZE | SWP_NOZORDER | SWP_SHOWWINDOW'));
assert(desktop.includes('if flags == PYWEBVIEW_MOVE_FLAGS:'));
assert(desktop.includes('position.contents.flags = flags | SWP_NOMOVE'));
assert(desktop.includes("CustomEvent('canvasdesktop:window-state'"));

console.log('desktop window contract passed');

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

const shownStart = desktop.indexOf('    def on_shown() -> None:');
const loadedStart = desktop.indexOf('    def on_loaded() -> None:', shownStart);
assert(shownStart >= 0 && loadedStart > shownStart);
const shownHandler = desktop.slice(shownStart, loadedStart);
const framelessIndex = shownHandler.indexOf('_install_frameless(window)');
const fitIndex = shownHandler.indexOf('_fit_restored_window(');
const maximizeIndex = shownHandler.indexOf('_show_window(window, SW_MAXIMIZE)');
assert(framelessIndex >= 0 && fitIndex > framelessIndex && maximizeIndex > fitIndex,
  'restored size must be committed after frameless setup and before startup maximize');

console.log('desktop window contract passed');

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const read = (name) => fs.readFileSync(path.join(root, name), 'utf8');
const html = read('assets/editor.html');
const lazy = read('assets/editor-lazy.js');
const fontLoader = read('assets/font-loader.js');
const dualViewer = read('assets/dual-viewer.html');
const editor = read('assets/editor.js');
const start = read('assets/start.js');
const styles = read('assets/styles.css');
const app = read('app.py');

assert(html.includes('<script src="editor-lazy.js" defer></script>'));
assert(html.indexOf('<script src="canvas.js" defer></script>') < html.indexOf('</head>'), 'critical scripts must be discovered from head');
assert(html.includes('window.__relatumOpeningRequests'));
['graph-gl.js', 'graph-engine.js', 'graph-view.js', 'editor-onboarding.js', 'ai.js', 'tooltip.js']
  .forEach((source) => assert(!html.includes('<script src="' + source + '" defer></script>'), source + ' must stay off the critical path'));
assert(!html.includes('<link rel="stylesheet" href="editor-onboarding.css">'));

assert(lazy.includes("loadScriptsInOrder(['graph-gl.js', 'graph-engine.js', 'graph-view.js'])"));
assert(lazy.includes("loadScript('ai.js')"));
assert(lazy.includes('ensureAIRuntime().catch'));
assert(lazy.includes('ensureGraphRuntime().catch'));
assert(lazy.includes('}, 3200);'), 'AI and graph runtimes should warm only after the editor enters an idle period');
assert(lazy.includes("loadStyle('editor-onboarding.css')"));
assert(lazy.includes("loadScript('tooltip.js')"));
assert(fontLoader.includes('window.RelatumFontLoader'));
assert(fontLoader.includes("document.fonts.load('16px \"KoseFont\"')"));
assert(html.includes('<script src="font-loader.js" defer></script>'));
assert(dualViewer.includes('<script src="font-loader.js" defer></script>'));
assert(!styles.includes("src: url('fonts/kose-font.woff2')"), 'the 12MB handwriting font must not be discovered from critical CSS');

assert(editor.includes('window.__relatumEditorReadyDetail = readyDetail'));
assert(editor.includes('const canvasOpeningRequest = openingRequests'));
assert(editor.includes("document.addEventListener('editor:graph-runtime-ready', setupGraphPanel)"));
assert(editor.includes("backgroundReady.catch((error) => console.warn('[画布] 背景恢复失败', error))"));
assert(!editor.includes('await backgroundReady;'), 'background images must not hold the opening cover');
assert(editor.includes('setLayerOpacity(0);'));

assert(start.includes("image.fetchPriority = 'low'"));
assert(!/requestIdleCallback\(preload/.test(start), 'background warming must begin before a fast navigation can cancel it');
assert(app.includes('cache_control="private, no-cache"'));
assert(app.includes('If-None-Match'));
assert(app.includes('self.send_response(304)'));

console.log('editor opening performance contract: ok');

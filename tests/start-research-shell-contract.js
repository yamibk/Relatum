'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const read = (name) => fs.readFileSync(path.join(root, name), 'utf8');
const html = read('assets/index.html');
const start = read('assets/start.js');
const styles = read('assets/styles.css');
const researchHtml = read('assets/research.html');
const researchStyles = read('assets/research/research.css');
const researchWorkspace = read('assets/research/research-workspace.js');
const app = read('app.py');
const desktop = read('desktop.py');
const shell = read('assets/desktop-shell.js');

const workspaceButtons = html.match(/<button type="button" role="tab" data-start-workspace=/g) || [];
assert.strictEqual(workspaceButtons.length, 4, 'the top bar must keep four workspace tabs');
assert(html.includes('data-start-workspace="research"')
  && html.includes('aria-controls="start-research-workspace">研究</button>'),
  'the Research tab must remain visible');
assert(/<section class="research-workspace start-workspace-panel" id="start-research-workspace"\s+data-start-workspace-panel="research" aria-label="研究工作区" hidden><\/section>/.test(html),
  'the initial start-page DOM must not contain a Research iframe');
assert(!/<(?:script|link)\b[^>]+(?:src|href)=["'][^"']*research/i.test(html),
  'Research resources must stay off the start-page critical path');

assert(start.includes('function loadResearchWorkspace()'));
assert(start.includes("document.createElement('iframe')") && start.includes("frame.src = 'research.html'"),
  'the same-origin Research iframe must be created on demand');
assert(start.includes("previous === 'research'") && start.includes('await researchWorkspaceApi.suspend()'),
  'leaving Research must suspend its active resources');
assert(start.includes("name === 'research'") && start.includes('await researchWorkspace.activate()'),
  'entering Research must activate the loaded workspace');
assert(start.includes("showWorkspacePanel('canvas', 'research', false)"),
  'a failed Research load must return to the canvas workspace');
assert(!start.includes('scheduleResearchWorkspaceIdleWarmup'),
  'Research must not gain an idle warmup path');
assert(start.includes("window.addEventListener('pagehide', disposeResearchWorkspace, { once: true })"),
  'the parent page must dispose the Research iframe lifecycle on pagehide');

assert(researchHtml.includes('<link rel="stylesheet" href="research/research.css">'));
assert(researchHtml.includes('<script src="research/research-workspace.js" defer></script>'));
assert(/<main class="research-stage" data-research-stage>[\s\S]*data-research-viewport[\s\S]*data-research-surface[\s\S]*<\/main>/.test(researchHtml),
  'the Research shell must contain the isolated canvas stage');
assert(!/<(?:h[1-6]|p|button|input|textarea)\b/i.test(researchHtml),
  'the Research canvas shell must not add visible controls or copy');
assert(/html,\s*\nbody\s*\{[\s\S]*?background:\s*transparent/.test(researchStyles)
  && /\.research-stage\s*\{[\s\S]*?background:\s*transparent/.test(researchStyles),
  'the iframe document and stage must stay transparent');
assert(styles.includes('.research-workspace-frame') && styles.includes('background: transparent'),
  'the parent iframe surface must stay borderless and transparent');

['activate: activate', 'suspend: suspend', 'dispose: dispose'].forEach((needle) => {
  assert(researchWorkspace.includes(needle), 'missing Research lifecycle method: ' + needle);
});
assert(researchWorkspace.includes("import('./research-editor.js')")
  && researchWorkspace.includes('runtime.suspend()')
  && researchWorkspace.includes("setPhase('suspended')")
  && researchWorkspace.includes("setPhase('disposed')"),
  'suspend and dispose must coordinate the isolated runtime');
assert(!researchWorkspace.includes('requestAnimationFrame(')
  && !researchWorkspace.includes('setInterval(')
  && !researchWorkspace.includes('setTimeout('),
  'the lifecycle bridge must leave rendering loops to the active-only canvas runtime');

const nonResearchRuntime = [app, desktop, shell].join('\n');
[
  '/api/research/',
  'set_research_workspace_active',
  'setResearchWorkspaceActive',
  'research_workspace_active',
].forEach((needle) => assert(!nonResearchRuntime.includes(needle), 'unexpected Research backend or desktop bridge: ' + needle));

console.log('start research shell contract passed');

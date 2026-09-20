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
assert(!start.includes('frame.title =')
  && start.includes("frame.setAttribute('aria-label', englishUI() ? 'Research workspace' : '研究工作区')"),
  'the full-page iframe must keep an accessible name without a native title tooltip');
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
assert(researchHtml.includes('data-research-add-search') && researchHtml.includes('data-research-inspector'),
  'the V2 shell must expose searchable node creation and an explicit property inspector');
const researchButtons = researchHtml.match(/<button\b/g) || [];
assert.strictEqual(researchButtons.length, 14,
  'the Research shell must keep page, wiring, simulation, and help controls intentionally bounded');
assert(researchHtml.includes('data-research-page-add') && researchHtml.includes('data-research-page-delete'),
  'the Research shell must expose its isolated in-memory page controls');
assert(researchHtml.includes('data-research-compute-dock')
  && researchHtml.includes('data-research-mode="select"')
  && researchHtml.includes('data-research-mode="relation"')
  && researchHtml.includes('data-research-mode="wire"')
  && researchHtml.includes('data-research-run')
  && researchHtml.includes('data-research-pause')
  && researchHtml.includes('data-research-step')
  && researchHtml.includes('data-research-reset')
  && researchHtml.includes('data-research-speed')
  && researchHtml.includes('data-research-trace') && researchHtml.includes('data-research-trace-clear')
  && researchHtml.includes('data-research-help-open') && researchHtml.includes('data-research-help-overlay'),
  'the Research shell must expose relation/wire modes, simulation controls, and bounded trace inspection');
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

assert(app.includes('/api/research/workspace'),
  'Research persistence must use its isolated backend namespace');
const nonResearchBridge = [desktop, shell].join('\n');
[
  'set_research_workspace_active',
  'setResearchWorkspaceActive',
  'research_workspace_active',
].forEach((needle) => assert(!nonResearchBridge.includes(needle), 'unexpected Research desktop bridge: ' + needle));

console.log('start research shell contract passed');

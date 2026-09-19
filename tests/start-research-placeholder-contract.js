'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const read = (name) => fs.readFileSync(path.join(root, name), 'utf8');
const html = read('assets/index.html');
const start = read('assets/start.js');
const styles = read('assets/styles.css');
const app = read('app.py');
const desktop = read('desktop.py');
const shell = read('assets/desktop-shell.js');

const workspaceButtons = html.match(/<button type="button" role="tab" data-start-workspace=/g) || [];
assert.strictEqual(workspaceButtons.length, 4, 'the top bar must keep four workspace tabs');
assert(html.includes('data-start-workspace="research"')
  && html.includes('aria-controls="start-research-workspace">研究</button>'),
  'the Research tab must remain visible');
assert(/<section class="research-workspace start-workspace-panel" id="start-research-workspace"\s+data-start-workspace-panel="research" aria-label="研究工作区" hidden><\/section>/.test(html),
  'Research must remain an empty workspace panel');
assert(start.includes('const START_WORKSPACE_ORDER = { canvas: 0, notes: 1, research: 2, career: 3 };'),
  'Research must remain a navigable workspace value');
assert(styles.includes('grid-template-columns: repeat(4, minmax(48px, 1fr));')
  && styles.includes('body[data-start-workspace="research"] .start-workspace-slider { transform: translateX(calc(200% + 2px)); }')
  && styles.includes('body[data-start-workspace="career"] .start-workspace-slider { transform: translateX(calc(300% + 3px)); }'),
  'the four-position workspace switch geometry must remain intact');

[
  ['assets/research', fs.existsSync(path.join(root, 'assets', 'research'))],
  ['research_library.py', fs.existsSync(path.join(root, 'research_library.py'))],
].forEach(([name, exists]) => assert.strictEqual(exists, false, name + ' must be removed'));

const runtimeSources = [html, start, styles, app, desktop, shell].join('\n');
[
  '/api/research/',
  'RelatumResearchWorkspace',
  'loadResearchWorkspace',
  'researchEntryDisabled',
  'canvas:researchEntryDisabled',
  'research-entry-toggle',
  'data-research-entry-disabled',
  'set_research_workspace_active',
  'setResearchWorkspaceActive',
  'research_workspace_active',
].forEach((needle) => assert(!runtimeSources.includes(needle), 'removed Research runtime leaked: ' + needle));

console.log('start research placeholder contract passed');

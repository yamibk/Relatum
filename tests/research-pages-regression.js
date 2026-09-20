'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const root = path.resolve(__dirname, '..');
const moduleAt = (name) => import(pathToFileURL(path.join(root, name)).href);

async function verifyPages() {
  const definitions = JSON.parse(fs.readFileSync(path.join(root, 'assets/research/research-node-definitions.json'), 'utf8'));
  const [{ createResearchRegistry }, { createResearchModel }, { createResearchPageSession }] = await Promise.all([
    moduleAt('assets/research/research-registry.js'), moduleAt('assets/research/research-model.js'),
    moduleAt('assets/research/research-pages.js'),
  ]);
  const registry = createResearchRegistry(definitions);
  const createModel = (state) => createResearchModel(state, registry);
  const note = (id, label) => ({ id, x: 10, y: 20, width: 168, height: 72, ...registry.createNode('note', { label }) });
  const session = createResearchPageSession({ createModel });

  const first = session.activePage();
  assert(first && first.id === 'research-page-1');
  assert.strictEqual(session.canDeleteActivePage(), false, 'page 1 must never be deletable');
  first.model.createNode(note('first-node', 'page one'));
  session.setPageView(first.id, { x: 120, y: -30, scale: 1.4 });
  session.setPageSpeed(first.id, 2);
  const second = session.createPage({ activate: false });
  assert.strictEqual(session.activePageId, first.id);
  first.runtime.computeProjection = { 'first-node': { status: 'ok' } };
  assert.strictEqual(second.runtime.computeProjection, null, 'runtime projections must stay isolated');

  session.activatePage(second.id);
  assert(session.canDeleteActivePage());
  second.model.createNode(note('second-node', 'page two'));
  assert(!session.canDeleteActivePage());
  assert(!first.model.node('second-node') && second.model.node('second-node'));
  second.model.remove(new Set(['second-node']), new Set());
  assert(session.canDeleteActivePage());
  assert(second.model.undo() && second.model.node('second-node'), 'each page keeps its own history');
  second.model.redo();

  const third = session.createPage();
  session.setPageView(third.id, { x: -75, y: 45, scale: 0.8 });
  const removedThird = session.deleteActiveEmptyPage();
  assert(removedThird && removedThird.active.id === second.id);
  const removedSecond = session.deleteActiveEmptyPage();
  assert(removedSecond && removedSecond.active.id === first.id);
  assert.deepStrictEqual(first.view, { x: 120, y: -30, scale: 1.4 });
  assert.strictEqual(first.model.node('first-node').label, 'page one');

  const persistent = {
    id: 'saved-register', x: 3, y: 8, width: 168, height: 72,
    ...registry.createNode('register', {
      config: { initial: { type: 'number', value: 0 } }, statePolicy: 'persist',
      savedState: { current: { type: 'number', value: 9 } },
    }),
  };
  const transient = {
    id: 'transient-toggle', x: 0, y: 0, width: 168, height: 72,
    ...registry.createNode('toggle', { statePolicy: 'reset' }), savedState: { current: true },
  };
  const hydrated = createResearchPageSession({
    createModel,
    document: {
      researchVersion: 2,
      pages: [
        { id: 'research-page-4', nodes: [persistent, transient], edges: [], view: { x: 9, y: 7, scale: 1.2 }, simulation: { speed: 4 } },
        { id: 'custom-page', nodes: [], edges: [], view: { x: -4, y: 2, scale: 0.75 }, simulation: { speed: 0.5 } },
      ],
      activePageId: 'custom-page',
    },
  });
  assert.strictEqual(hydrated.activePageId, 'custom-page');
  assert(hydrated.page('research-page-4').model.node('saved-register'));
  hydrated.page('research-page-4').runtime.computeProjection = { saved: { status: 'ok' } };
  const serialized = hydrated.toDocument((page) => page.id === 'research-page-4'
    ? { 'saved-register': { current: { type: 'number', value: 11 } } } : {});
  assert.strictEqual(serialized.researchVersion, 2);
  assert.deepStrictEqual(serialized.pages[0].view, { x: 9, y: 7, scale: 1.2 });
  assert.deepStrictEqual(serialized.pages[0].simulation, { speed: 4 });
  assert.strictEqual(serialized.pages[0].nodes[0].savedState.current.value, 11);
  assert(!Object.prototype.hasOwnProperty.call(serialized.pages[0].nodes[1], 'savedState'),
    'reset-policy nodes must never serialize state');
  assert(!Object.prototype.hasOwnProperty.call(serialized.pages[0], 'runtime'), 'runtime caches must never persist');
  const appended = hydrated.createPage();
  assert.strictEqual(appended.id, 'research-page-5');
  assert.strictEqual(hydrated.page('research-page-4').model.undo(), false, 'loaded pages start with fresh history');
}

verifyPages().then(() => console.log('research pages regression passed')).catch((error) => {
  console.error(error); process.exitCode = 1;
});

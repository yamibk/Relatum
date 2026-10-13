'use strict';

// Exercise production motion and close logic without a browser or user data.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../assets/note-workspace.js'), 'utf8');
const motionSource = source.slice(source.indexOf('  function releaseTabCloseClip()'), source.indexOf('  function renderTabs()'));
const closeSource = source.slice(source.indexOf('  async function closeTab('), source.indexOf('  function switchTab('));
assert(motionSource && closeSource, 'production entry points must be available');

function motionHarness() {
  const events = [], animations = [];
  const node = (name, left, width = 100) => ({
    name, left, width, visualDelta: 0, isConnected: true, dataset: { noteTabPath: name },
    getBoundingClientRect() {
      events.push('read:' + name);
      const x = this.left + this.visualDelta;
      return { left: x, right: x + this.width, width: this.width };
    },
    animate(frames, options) {
      events.push('animate:' + name);
      this.visualDelta = Number(frames[0].transform.match(/translateX\(([-\d.]+)px\)/)[1]);
      const element = this;
      const animation = { frames, options, onfinish: null, oncancel: null, cancelled: false,
        cancel() { events.push('cancel:' + name); this.cancelled = true; element.visualDelta = 0; this.oncancel?.(); },
        finish() { element.visualDelta = 0; this.onfinish?.(); } };
      animations.push(animation); return animation;
    },
  });
  const a = node('a', 0), b = node('b', 100), c = node('c', 200), actions = node('actions', 300, 60);
  const sandbox = { tabCloseMotionPending: false, tabCloseClipActive: false, tabScrollFrame: 0, tabCloseMotionScrollLeft: 0,
    tabCloseAnimations: new Map(), tabMotionPreference: { matches: false }, visible: true,
    state: { tabs: ['a', 'c'], draggedTabPath: '' }, tabActions: actions,
    tabBar: node('bar', 0, 600), tabsEl: node('strip', 0, 300),
    cancelAnimationFrame(id) { events.push('cancel-frame:' + id); } };
  sandbox.tabsEl.children = [a, b, c]; sandbox.tabsEl.scrollLeft = 0;
  const classes = new Set(), properties = new Map();
  sandbox.tabsEl.classList = { add: name => classes.add(name), remove: name => classes.delete(name), contains: name => classes.has(name) };
  sandbox.tabsEl.style = { setProperty: (name, value) => properties.set(name, value), removeProperty: name => properties.delete(name) };
  sandbox.noteWorkspaceVisible = () => sandbox.visible;
  vm.createContext(sandbox);
  vm.runInContext(motionSource + '\nglobalThis.motion = { capture: captureTabCloseMotion, play: playTabCloseMotion, cancel: cancelTabCloseMotion, cancelScroll: cancelTabScroll };', sandbox);
  return { ...sandbox, sandbox, a, b, c, actions, events, animations,
    closeB() {
      sandbox.tabCloseMotionPending = true;
      const snapshot = sandbox.motion.capture();
      sandbox.tabsEl.children = [a, c]; b.isConnected = false; c.left = 100; actions.left = 200;
      sandbox.motion.play(snapshot);
    } };
}

{
  const h = motionHarness();
  assert.equal(h.motion.capture(), null, 'ordinary updates do not read layout');
  assert.equal(h.events.length, 0);
  h.closeB();
  assert.equal(h.tabCloseAnimations.size, 2, 'only the moved survivor and action group animate');
  assert.equal(h.animations[0].frames[0].transform, 'translateX(100px)');
  assert.equal(h.animations[0].options.duration, 230);
  const firstWrite = h.events.findIndex(event => event.startsWith('animate:'));
  assert(h.events.slice(firstWrite).every(event => !event.startsWith('read:')), 'all measurements precede animation writes');
  const count = h.events.length;
  assert.equal(h.motion.capture(), null);
  assert.equal(h.events.length, count, 'an unchanged render leaves the current animation running');
  h.animations.forEach(animation => animation.finish());
  assert.equal(h.tabCloseAnimations.size, 0, 'completed animations release references');
}
{
  const h = motionHarness(); h.sandbox.tabCloseMotionPending = true;
  const snapshot = h.motion.capture();
  h.tabsEl.children = [h.a, h.c]; h.c.left = 100; h.actions.left = 200; h.tabsEl.width = 200;
  h.motion.play(snapshot);
  assert(h.tabsEl.classList.contains('is-close-motion'), 'a smaller list keeps its previous clip during movement');
  h.animations[0].finish();
  assert(h.tabsEl.classList.contains('is-close-motion'), 'the clip stays until all movements finish');
  h.animations[1].finish();
  assert(!h.tabsEl.classList.contains('is-close-motion'), 'the last completion releases the clip');
  h.sandbox.tabCloseMotionPending = true; const next = h.motion.capture();
  h.c.left = 0; h.actions.left = 100; h.tabsEl.width = 100; h.motion.play(next);
  h.motion.cancel();
  assert(!h.tabsEl.classList.contains('is-close-motion'), 'cancelling also releases the clip');
}
{
  const h = motionHarness(); h.closeB();
  const staleFinish = h.animations[0].onfinish;
  h.c.visualDelta = 40; h.actions.visualDelta = 40;
  h.state.tabs = ['c']; h.sandbox.tabCloseMotionPending = true;
  const snapshot = h.motion.capture();
  assert(h.animations.every(animation => animation.cancelled));
  h.tabsEl.children = [h.c]; h.a.isConnected = false; h.c.left = 0; h.actions.left = 100;
  h.motion.play(snapshot);
  assert.equal(h.animations[2].frames[0].transform, 'translateX(140px)', 'a consecutive close resumes from the current visual position');
  staleFinish();
  assert.equal(h.tabCloseAnimations.size, 2, 'an old finish cannot remove a new animation');
  h.sandbox.tabScrollFrame = 12; h.motion.cancel();
  assert.equal(h.tabCloseAnimations.size, 0);
  assert.equal(h.sandbox.tabScrollFrame, 12, 'motion cleanup does not cancel an ordinary active-tab reveal');
  h.motion.cancelScroll();
  assert.equal(h.sandbox.tabScrollFrame, 0);
  assert(h.events.includes('cancel-frame:12'));
}
for (const mode of ['reduced', 'hidden', 'dragging', 'unsupported']) {
  const h = motionHarness();
  if (mode === 'reduced') h.tabMotionPreference.matches = true;
  if (mode === 'hidden') h.sandbox.visible = false;
  if (mode === 'dragging') h.state.draggedTabPath = 'c';
  if (mode === 'unsupported') h.tabsEl.animate = undefined;
  h.sandbox.tabCloseMotionPending = true;
  assert.equal(h.motion.capture(), null, mode + ' skips motion');
  assert.equal(h.events.length, 0, mode + ' skips layout reads');
}
{
  const h = motionHarness(); h.state.tabs = []; h.sandbox.tabCloseMotionPending = true;
  const snapshot = h.motion.capture();
  assert(!h.events.some(event => /^read:[abc]$/.test(event)), 'closing all only measures the action group');
  h.tabsEl.children = []; h.actions.left = 0; h.motion.play(snapshot);
  assert.equal(h.animations.length, 1);
  assert.equal(h.animations[0].frames[0].transform, 'translateX(300px)');
}
{
  const h = motionHarness(); h.c.left = 700; h.closeB();
  // In this harness closeB brings c into view, so it must slide in from its old position.
  assert.equal(h.animations[0].frames[0].transform, 'translateX(600px)');
  h.motion.cancel(); h.c.left = 700; h.sandbox.tabCloseMotionPending = true;
  const snapshot = h.motion.capture(); h.c.left = 600; h.motion.play(snapshot);
  assert.equal(h.tabCloseAnimations.size, 0, 'fully offscreen survivors do not hold animations');
}
{
  const h = motionHarness(); h.state.tabs = ['c']; h.c.left = 100; h.tabsEl.scrollLeft = 100;
  h.sandbox.tabCloseMotionPending = true;
  const snapshot = h.motion.capture();
  h.tabsEl.children = [h.c]; h.tabsEl.scrollLeft = 0;
  // Removing a tab and clamping native scroll can leave a survivor at the same screen coordinate.
  h.motion.play(snapshot);
  assert.equal(h.animations.length, 0, 'native scroll offsets are not added to measured visual movement');
}
{
  const h = motionHarness(); h.actions.animate = () => { throw new Error('unavailable'); };
  h.closeB();
  assert.equal(h.tabCloseAnimations.size, 0, 'animation failure falls back to final layout');
  assert(h.animations[0].cancelled);
}
{
  const h = motionHarness(), s = h.sandbox;
  const layout = () => {
    s.tabsEl.children.forEach((tab, index) => { tab.left = index * 100; });
    s.tabsEl.width = s.tabsEl.children.length * 100; h.actions.left = s.tabsEl.width;
  };
  for (const tab of s.tabsEl.children) {
    tab.title = tab.name; tab.className = 'note-tab';
    const label = {}, close = { dataset: {}, setAttribute() {} };
    tab.querySelector = selector => selector === '.note-tab-label' ? label : selector === '.note-tab-close' ? close : null;
    tab.setAttribute = tab.removeAttribute = () => {};
    tab.remove = () => { s.tabsEl.children.splice(s.tabsEl.children.indexOf(tab), 1); tab.isConnected = false; layout(); };
  }
  s.tabsEl.insertBefore = (tab, target) => {
    s.tabsEl.children.splice(s.tabsEl.children.indexOf(tab), 1);
    s.tabsEl.children.splice(target ? s.tabsEl.children.indexOf(target) : s.tabsEl.children.length, 0, tab); layout();
  };
  s.tabsEl.querySelector = () => s.tabsEl.children.find(tab => tab.className.split(' ').includes('active'));
  Object.assign(s, { language: () => 'en', tr: key => key, isGraphTab: () => false, isBlankTab: () => false, noteTitle: name => name,
    newTabButton: null, closeAllTabsButton: null });
  s.state.activeTab = s.state.renderedActiveTab = 'a';
  vm.runInContext(source.slice(source.indexOf('  function renderTabs()'), source.indexOf('  function remapTabs('))
    + '\nglobalThis.render = renderTabs;', s);
  s.tabCloseMotionPending = true; s.render();
  assert.deepEqual(s.tabsEl.children, [h.a, h.c], 'the real renderer removes only the closed node');
  assert.equal(s.tabCloseAnimations.size, 2);
  const started = h.animations.length; s.render();
  assert.equal(s.tabCloseAnimations.size, 2, 'a follow-up render keeps close motion intact');
  assert.equal(h.animations.length, started, 'a follow-up render does not restart motion');
  s.state.tabs = ['c', 'a']; s.render();
  assert.equal(s.tabCloseAnimations.size, 0, 'ordinary reorder ends stale motion without starting another');
  assert.equal(h.animations.length, started);
}

function closeHarness() {
  const documents = new Map(['a', 'b', 'c'].map(name => [name, { path: name }]));
  const state = { tabs: ['a', 'b', 'c'], activeTab: 'c', current: documents.get('c'), documentCache: documents };
  const renders = [], releases = [], saved = [];
  const sandbox = { state, tabCloseMotionPending: false, noteMovePromise: null, noteGraphIntentSequence: 0,
    noteGraph: { deactivate(options) { releases.push(options); } },
    flushCanvases: async () => true, flushSave: async document => { saved.push(document.path); return true; },
    isSpecialTab: tab => tab === 'graph' || tab.startsWith('blank:'), isGraphTab: tab => tab === 'graph',
    persistTabs() {}, backgroundTargetChanged() {}, activateTab: async () => true,
    renderTabs() { renders.push({ tabs: state.tabs.slice(), motion: sandbox.tabCloseMotionPending }); sandbox.tabCloseMotionPending = false; },
    clearCurrent() { state.current = null; sandbox.renderTabs(); } };
  vm.createContext(sandbox);
  vm.runInContext(closeSource + '\nglobalThis.close = { one: closeTab, all: closeAllTabs };', sandbox);
  return { sandbox, state, renders, releases, saved, close: sandbox.close };
}

(async () => {
  {
    const h = closeHarness(); h.sandbox.flushSave = async () => false;
    assert.equal(await h.close.one('b'), false);
    assert.equal(await h.close.all(), false);
    assert.deepEqual(h.state.tabs, ['a', 'b', 'c']); assert.equal(h.renders.length, 0);
    assert.equal(h.sandbox.tabCloseMotionPending, false, 'failed saves do not queue animation');
  }
  {
    const h = closeHarness(); let releaseSave, entered;
    const saving = new Promise(resolve => { entered = resolve; });
    h.sandbox.flushSave = document => document.path === 'b' ? new Promise(resolve => { releaseSave = resolve; entered(); }) : Promise.resolve(true);
    const closingB = h.close.one('b'); await saving;
    assert.equal(await h.close.one('a'), true);
    releaseSave(true); assert.equal(await closingB, true);
    assert.deepEqual(h.state.tabs, ['c'], 'a shifted index cannot close the next tab');
    assert.equal(h.renders.length, 2); assert(h.renders.every(render => render.motion));
  }
  {
    const h = closeHarness(), saves = []; let entered;
    const saving = new Promise(resolve => { entered = resolve; });
    h.sandbox.flushSave = () => new Promise(resolve => { saves.push(resolve); if (saves.length === 2) entered(); });
    const first = h.close.one('b'), second = h.close.one('b'); await saving;
    saves[0](true); assert.equal(await first, true);
    saves[1](true); assert.equal(await second, false);
    assert.deepEqual(h.state.tabs, ['a', 'c']); assert.equal(h.renders.length, 1, 'duplicate closes commit once');
  }
  {
    const h = closeHarness(); let entered, releaseSave, activated;
    const saving = new Promise(resolve => { entered = resolve; });
    h.sandbox.flushSave = () => new Promise(resolve => { releaseSave = resolve; entered(); });
    h.sandbox.activateTab = async tab => { activated = tab; return true; };
    const closing = h.close.one('b'); await saving;
    h.state.activeTab = 'b'; releaseSave(true); await closing;
    assert.equal(activated, 'c', 'active identity is rechecked after saving');
  }
  {
    const h = closeHarness(); h.sandbox.activateTab = async () => false;
    assert.equal(await h.close.one('c'), false);
    assert.deepEqual(h.renders[0].tabs, ['a', 'b'], 'the closed tab disappears before a failed next-note read');
  }
  for (const tab of ['a', 'blank:1', 'graph']) {
    const h = closeHarness(); h.state.tabs = [tab]; h.state.activeTab = tab;
    assert.equal(await h.close.one(tab), true);
    assert.equal(h.state.tabs.length, 0); assert(h.renders[0].motion);
    assert.equal(h.releases.length, tab === 'graph' ? 1 : 0, 'graph release does not wait for animation');
  }
  {
    const h = closeHarness(); assert.equal(await h.close.all(), true);
    assert.deepEqual(h.saved, ['c', 'a', 'b']); assert.equal(h.state.tabs.length, 0);
    assert(h.renders[0].motion); assert.equal(h.releases.length, 1);
  }
  console.log('note tab motion and close regression: ok');
})().catch(error => { console.error(error); process.exitCode = 1; });

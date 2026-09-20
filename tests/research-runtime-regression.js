'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const root = path.resolve(__dirname, '..');
const moduleAt = (name) => import(pathToFileURL(path.join(root, name)).href);
const wire = (id, fromNodeId, fromPortId, toNodeId, toPortId) => ({
  id, kind: 'wire', from: { nodeId: fromNodeId, portId: fromPortId }, to: { nodeId: toNodeId, portId: toPortId },
});

async function main() {
  const definitions = JSON.parse(fs.readFileSync(path.join(root, 'assets/research/research-node-definitions.json'), 'utf8'));
  const [{ createResearchRegistry }, compute, { createResearchSimulationController }] = await Promise.all([
    moduleAt('assets/research/research-registry.js'), moduleAt('assets/research/research-compute.js'),
    moduleAt('assets/research/research-runtime.js'),
  ]);
  const registry = createResearchRegistry(definitions);
  const node = (id, type, config = {}, extra = {}) => ({
    id, x: 0, y: 0, width: 168, height: 80, ...registry.createNode(type, { config, ...extra }),
  });
  const makeRuntime = (period, counterId) => {
    const clock = node('clock-' + counterId, 'clock', { periodMs: period });
    const counter = node(counterId, 'counter', { initial: { type: 'number', value: 0 }, overflow: 'wrap' });
    return compute.createResearchComputeRuntime({ nodes: [clock, counter], edges: [wire('tick-' + counterId, clock.id, 'tick', counter.id, 'inc')] }, { registry });
  };
  const runtimes = new Map([['page-a', makeRuntime(1000, 'counter-a')], ['page-b', makeRuntime(500, 'counter-b')]]);
  let now = 10000;
  let nextTimerId = 0;
  const pending = new Map();
  const callbacks = [];
  const updates = [];
  const states = [];
  const controller = createResearchSimulationController({
    getRuntime: (pageId) => runtimes.get(pageId),
    now: () => now,
    setTimer(callback, delay) {
      const id = ++nextTimerId;
      const wrapped = () => { pending.delete(id); callback(); };
      pending.set(id, { callback: wrapped, delay });
      callbacks.push(wrapped);
      return id;
    },
    clearTimer(id) { pending.delete(id); },
    onUpdate(pageId, result, detail) { updates.push({ pageId, result, detail }); },
    onStateChange(pageId, state) { states.push({ pageId, state }); },
  });

  controller.selectPage('page-a', 1);
  controller.activate();
  assert.strictEqual(controller.stats().running, false, 'cold start must be paused');
  assert.strictEqual(controller.step(), true);
  assert.strictEqual(runtimes.get('page-a').projection['counter-a'].output.value, 1, 'step must advance through the next clock boundary');
  assert(updates.at(-1).detail.step, 'step must publish a complete update');

  controller.setSpeed(4);
  controller.run();
  assert.strictEqual(controller.stats().speed, 4);
  assert.strictEqual(controller.stats().running, true);
  const simulationTimer = Array.from(pending.values()).find((entry) => entry.delay < 1000);
  assert(simulationTimer && simulationTimer.delay === 250, '4x speed must divide the wall delay');
  now += simulationTimer.delay;
  simulationTimer.callback();
  assert.strictEqual(runtimes.get('page-a').projection['counter-a'].output.value, 2, 'scheduled boundary must emit one tick');

  controller.pause();
  const pausedValue = runtimes.get('page-a').projection['counter-a'].output.value;
  assert.strictEqual(controller.stats().running, false);
  assert.strictEqual(pending.size, 1, 'pause may keep only the independent wall-time refresh');
  controller.step();
  assert.strictEqual(runtimes.get('page-a').projection['counter-a'].output.value, pausedValue + 1, 'step must work while paused');

  controller.run();
  controller.setVisible(false);
  assert.strictEqual(pending.size, 0, 'hidden pages must cancel every scheduling handle');
  assert.strictEqual(controller.stats().resumeIntent, true, 'visibility suspension must preserve run intent');
  now += 10000;
  controller.setVisible(true);
  assert.strictEqual(controller.stats().running, true, 'visible page must restore its previous run intent');
  assert.strictEqual(runtimes.get('page-a').projection['counter-a'].output.value, pausedValue + 1,
    'hidden wall time must not advance simulation time');

  const stale = callbacks.at(-1);
  controller.selectPage('page-b', 0.5);
  const pageABefore = runtimes.get('page-a').projection['counter-a'].output.value;
  const pageBBefore = runtimes.get('page-b').projection['counter-b'].output.value;
  stale();
  assert.strictEqual(runtimes.get('page-a').projection['counter-a'].output.value, pageABefore);
  assert.strictEqual(runtimes.get('page-b').projection['counter-b'].output.value, pageBBefore,
    'stale callbacks must not target a newly selected page');
  controller.step();
  assert.strictEqual(runtimes.get('page-b').projection['counter-b'].output.value, pageBBefore + 1);
  assert.strictEqual(runtimes.get('page-a').projection['counter-a'].output.value, pageABefore, 'page runtimes must stay isolated');

  const manualStart = node('manual-start', 'button');
  const manualTimer = node('manual-timer', 'timer', { mode: 'countdown', durationMs: 100, precisionMs: 20 });
  runtimes.set('page-c', compute.createResearchComputeRuntime({
    nodes: [manualStart, manualTimer],
    edges: [wire('manual-start-timer', manualStart.id, 'fire', manualTimer.id, 'start')],
  }, { registry }));
  controller.selectPage('page-c', 1);
  controller.run();
  assert(!Array.from(pending.values()).some((entry) => entry.delay < 1000),
    'an idle Timer must not create a simulation schedule');
  compute.activateResearchNode(runtimes.get('page-c'), manualStart.id);
  controller.refresh();
  assert(Array.from(pending.values()).some((entry) => entry.delay === 20),
    'a manual start event must be able to refresh a running controller schedule');
  controller.pause();

  controller.reset();
  assert.strictEqual(runtimes.get('page-c').projection['manual-timer'].outputs.running.value, false,
    'reset must restore the selected page state');
  controller.suspend();
  assert.strictEqual(pending.size, 0, 'iframe suspension must cancel all handles');
  controller.activate();
  assert.strictEqual(controller.stats().running, false, 'a page explicitly left paused must remain paused after resume');

  controller.run();
  controller.dispose();
  assert.strictEqual(pending.size, 0, 'dispose must cancel all handles');
  callbacks.at(-1)();
  assert.strictEqual(controller.stats().active, false, 'disposed callbacks must be inert');
  assert(controller.stats().cancellationCount > 0);
  assert(states.length > 0);

  const manyClocks = [];
  for (let index = 0; index < 1000; index += 1) manyClocks.push(node('many-clock-' + index, 'clock', { periodMs: 1000 }));
  const manyRuntime = compute.createResearchComputeRuntime({ nodes: manyClocks, edges: [] }, { registry });
  let task = null; let slice; let calls = 0; let processed = 0;
  do {
    slice = compute.advanceResearchTimeSlice(manyRuntime, 1000, task, {
      maxSources: 64, timeBudgetMs: 4, measureNow: () => 0,
    });
    task = slice.task; calls += 1; processed += slice.processed;
    assert(slice.processed <= 64, 'one cooperative time slice must respect the source-count budget');
    if (!slice.done) assert.strictEqual(manyRuntime.simulationTime, 0, 'a partial batch must not expose half-advanced simulation time');
  } while (!slice.done);
  assert.strictEqual(calls, Math.ceil(1000 / 64));
  assert.strictEqual(processed, 1000);
  assert.strictEqual(manyRuntime.simulationTime, 1000);
  assert.strictEqual(manyRuntime.counters.pulseCount, 1000, 'all same-time clock pulses must commit as one deterministic batch');

  console.log('research runtime regression passed');
}

main().catch((error) => { console.error(error); process.exitCode = 1; });

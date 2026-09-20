'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { buildResearchCircuitFixture } = require('./research-circuit-fixtures.js');

const root = path.resolve(__dirname, '..');
const moduleAt = (name) => import(pathToFileURL(path.join(root, name)).href);

function wire(id, fromNodeId, fromPortId, toNodeId, toPortId) {
  return { id, kind: 'wire', from: { nodeId: fromNodeId, portId: fromPortId }, to: { nodeId: toNodeId, portId: toPortId } };
}

async function main() {
  const definitions = JSON.parse(fs.readFileSync(path.join(root, 'assets/research/research-node-definitions.json'), 'utf8'));
  const [{ createResearchRegistry }, schema, { createResearchModel }, compute] = await Promise.all([
    moduleAt('assets/research/research-registry.js'),
    moduleAt('assets/research/research-schema.js'),
    moduleAt('assets/research/research-model.js'),
    moduleAt('assets/research/research-compute.js'),
  ]);
  const registry = createResearchRegistry(definitions);
  const browserFixture = buildResearchCircuitFixture();
  const fixtureValidation = schema.validateResearchDocument(browserFixture, registry);
  assert(fixtureValidation.ok, 'browser acceptance circuits must remain a valid public V2 document: '
    + fixtureValidation.errors.map((error) => error.code).join(', '));
  assert.strictEqual(browserFixture.pages.length, 4, 'browser fixture must keep one independent page per acceptance circuit');
  let x = 0;
  const node = (id, type, config = {}, extra = {}) => ({
    id, x: x += 20, y: 0, width: 168, height: 80,
    ...registry.createNode(type, { config, ...extra }),
  });
  const output = (runtime, nodeId, portId = 'out') => runtime.projection[nodeId].outputs[portId];

  const baseNodes = [
    node('five', 'constant', { value: { type: 'number', value: 5 } }),
    node('six', 'constant', { value: { type: 'number', value: 6 } }),
    node('add', 'math', { operation: 'add' }),
    node('monitor', 'monitor'),
  ];
  const baseEdges = [
    wire('five-add', 'five', 'out', 'add', 'a'),
    wire('six-add', 'six', 'out', 'add', 'b'),
    wire('add-monitor', 'add', 'out', 'monitor', 'in'),
    { id: 'knowledge', kind: 'relation', fromNodeId: 'five', toNodeId: 'monitor' },
  ];
  const document = schema.createResearchDocument({
    pages: [{ id: 'research-page-1', nodes: baseNodes, edges: baseEdges, view: { x: 12, y: 30, scale: 1.2 } }],
    activePageId: 'research-page-1',
  }, registry);
  assert.strictEqual(document.researchVersion, 2);
  assert(schema.validateResearchDocument(document, registry).ok, 'V2 typed graph must validate');
  assert(!schema.validateResearchDocument({ ...document, researchVersion: 1 }, registry).ok, 'V1 must be rejected');

  const duplicate = structuredClone(document);
  duplicate.pages[0].edges.push(wire('duplicate', 'six', 'out', 'add', 'a'));
  assert(schema.validateResearchDocument(duplicate, registry).errors.some((error) => error.code === 'duplicate-value-input'));
  const mixedChannel = structuredClone(document);
  mixedChannel.pages[0].nodes.push(node('button-bad', 'button'));
  mixedChannel.pages[0].edges.push(wire('event-to-value', 'button-bad', 'fire', 'add', 'a'));
  assert(schema.validateResearchDocument(mixedChannel, registry).errors.some((error) => error.code === 'incompatible-wire'));

  const model = createResearchModel({ nodes: baseNodes, edges: baseEdges }, registry);
  assert(!model.canCreateWire('five', 'out', 'add', 'a').ok, 'occupied value input must reject another wire');
  assert(!model.canCreateWire('five', 'out', 'monitor', 'in').ok, 'occupied monitor input must reject another wire');
  assert(!model.canCreateWire('five', 'out', 'add', 'missing').ok, 'unknown ports must reject wires');
  const runtime = compute.createResearchComputeRuntime(model.snapshot(), { registry, wallTime: 12345 });
  assert.deepStrictEqual(output(runtime, 'add'), { type: 'number', value: 11 });
  assert.deepStrictEqual(runtime.projection.monitor.output, { type: 'number', value: 11 });
  assert.strictEqual(runtime.compiled.stats.relationCount, 1, 'relations must not enter execution');

  model.updateNode('five', { config: { value: { type: 'number', value: 8 } } });
  compute.updateResearchComputeRuntime(runtime, { nodes: [model.node('five')] }, { dirtyNodeIds: new Set(['five']) });
  assert.strictEqual(output(runtime, 'add').value, 14, 'dirty propagation must update downstream only');
  assert(model.undo() && model.node('five').config.value.value === 5, 'configuration edits must be undoable');

  function run(nodes, edges) {
    return compute.createResearchComputeRuntime({ nodes, edges }, { registry });
  }
  const numberA = node('number-a', 'constant', { value: { type: 'number', value: 9 } });
  const numberB = node('number-b', 'constant', { value: { type: 'number', value: 4 } });
  for (const [operation, expected] of [['subtract', 5], ['multiply', 36], ['divide', 2.25], ['modulo', 1]]) {
    const op = node('math-' + operation, 'math', { operation });
    const current = run([numberA, numberB, op], [
      wire('a-' + operation, numberA.id, 'out', op.id, 'a'), wire('b-' + operation, numberB.id, 'out', op.id, 'b'),
    ]);
    assert.strictEqual(output(current, op.id).value, expected, operation);
  }
  const zero = node('zero', 'constant', { value: { type: 'number', value: 0 } });
  const divide = node('divide-zero', 'math', { operation: 'divide' });
  const zeroRun = run([numberA, zero, divide], [wire('az', numberA.id, 'out', divide.id, 'a'), wire('zz', zero.id, 'out', divide.id, 'b')]);
  assert.strictEqual(zeroRun.projection[divide.id].error.code, 'divide-by-zero');

  const bits255 = node('bits-255', 'constant', { value: { type: 'bits', width: 8, value: '0xff' } });
  const bitsOne = node('bits-one', 'constant', { value: { type: 'bits', width: 8, value: '0x1' } });
  const bitsAdd = node('bits-add', 'math', { operation: 'add' });
  let bitsRun = run([bits255, bitsOne, bitsAdd], [wire('ba', bits255.id, 'out', bitsAdd.id, 'a'), wire('bb', bitsOne.id, 'out', bitsAdd.id, 'b')]);
  assert.deepStrictEqual(output(bitsRun, bitsAdd.id), { type: 'bits', width: 8, value: '0x0' }, 'Bits math must wrap modulo 2^N');
  const bits16 = node('bits-16', 'constant', { value: { type: 'bits', width: 16, value: '0x1' } });
  const widthModel = createResearchModel({ nodes: [bits255, bits16, bitsAdd], edges: [] }, registry);
  assert(widthModel.createEdge(bits255.id, bitsAdd.id, { kind: 'wire', fromPortId: 'out', toPortId: 'a' }));
  assert(!widthModel.createEdge(bits16.id, bitsAdd.id, { kind: 'wire', fromPortId: 'out', toPortId: 'b' }),
    'known Bits width mismatches must be rejected while wiring');
  for (const [width, value, expected] of [[1, '0x3', '0x1'], [16, '0x10001', '0x1'], [32, '0xffffffff', '0xffffffff'], [64, '0xffffffffffffffff', '0xffffffffffffffff']]) {
    assert.deepStrictEqual(registry.normalizeTypedValue({ type: 'bits', width, value }), { type: 'bits', width, value: expected });
  }
  const shiftBy = node('shift-by', 'constant', { value: { type: 'number', value: 2 } });
  const shift = node('shift', 'bits', { operation: 'shift-left', width: 8 });
  bitsRun = run([bitsOne, shiftBy, shift], [wire('sa', bitsOne.id, 'out', shift.id, 'a'), wire('sb', shiftBy.id, 'out', shift.id, 'b')]);
  assert.strictEqual(output(bitsRun, shift.id).value, '0x4');
  const bitsTwo = node('bits-two', 'constant', { value: { type: 'bits', width: 8, value: '0x1' } });
  const concat = node('concat', 'bits', { operation: 'concat' });
  bitsRun = run([bitsOne, bitsTwo, concat], [wire('ca', bitsOne.id, 'out', concat.id, 'a'), wire('cb', bitsTwo.id, 'out', concat.id, 'b')]);
  assert.deepStrictEqual(output(bitsRun, concat.id), { type: 'bits', width: 16, value: '0x101' });
  const slice = node('slice', 'bits', { operation: 'slice', start: 4, width: 4 });
  bitsRun = run([bits255, slice], [wire('slice-a', bits255.id, 'out', slice.id, 'a')]);
  assert.deepStrictEqual(output(bitsRun, slice.id), { type: 'bits', width: 4, value: '0xf' });
  const resize = node('resize', 'bits', { operation: 'resize', width: 4 });
  bitsRun = run([bits255, resize], [wire('resize-a', bits255.id, 'out', resize.id, 'a')]);
  assert.deepStrictEqual(output(bitsRun, resize.id), { type: 'bits', width: 4, value: '0xf' });

  const boolTrue = node('bool-true', 'constant', { value: { type: 'boolean', value: true } });
  const boolFalse = node('bool-false', 'constant', { value: { type: 'boolean', value: false } });
  const logic = node('logic-and', 'logic', { operation: 'and' });
  const compare = node('compare', 'compare', { operation: 'greater' });
  const select = node('select-node', 'select');
  const selected = run([boolTrue, boolFalse, logic, numberA, numberB, compare, select], [
    wire('lt', boolTrue.id, 'out', logic.id, 'a'), wire('lf', boolFalse.id, 'out', logic.id, 'b'),
    wire('cmpa', numberA.id, 'out', compare.id, 'a'), wire('cmpb', numberB.id, 'out', compare.id, 'b'),
    wire('cond', compare.id, 'out', select.id, 'condition'), wire('sel-a', numberA.id, 'out', select.id, 'whenTrue'),
    wire('sel-b', numberB.id, 'out', select.id, 'whenFalse'),
  ]);
  assert.strictEqual(output(selected, logic.id).value, false);
  assert.strictEqual(output(selected, compare.id).value, true);
  assert.strictEqual(output(selected, select.id).value, 9);

  const pureA = node('pure-a', 'logic', { operation: 'not' });
  const pureB = node('pure-b', 'logic', { operation: 'not' });
  const pureCycle = run([pureA, pureB], [wire('ab', pureA.id, 'out', pureB.id, 'a'), wire('ba2', pureB.id, 'out', pureA.id, 'a')]);
  assert(pureCycle.result.errors.some((error) => error.code === 'combinational-cycle'), 'pure combinational cycles must fail');

  const pulse = node('pulse', 'button');
  const one = node('one', 'constant', { value: { type: 'number', value: 1 } });
  const addFeedback = node('add-feedback', 'math', { operation: 'add' });
  const register = node('register', 'register', { initial: { type: 'number', value: 0 } });
  const feedback = run([pulse, one, addFeedback, register], [
    wire('reg-add', register.id, 'out', addFeedback.id, 'a'), wire('one-add', one.id, 'out', addFeedback.id, 'b'),
    wire('add-reg', addFeedback.id, 'out', register.id, 'data'), wire('pulse-reg', pulse.id, 'fire', register.id, 'write'),
  ]);
  assert(!feedback.result.errors.some((error) => error.code === 'combinational-cycle'), 'register must form a legal state boundary');
  compute.activateResearchNode(feedback, pulse.id);
  assert.strictEqual(output(feedback, register.id).value, 1);
  compute.activateResearchNode(feedback, pulse.id);
  assert.strictEqual(output(feedback, register.id).value, 2);

  const regA = node('reg-a', 'register', { initial: { type: 'number', value: 1 } });
  const regB = node('reg-b', 'register', { initial: { type: 'number', value: 2 } });
  const syncButton = node('sync', 'button');
  const synchronous = run([regA, regB, syncButton], [
    wire('a-data', regB.id, 'out', regA.id, 'data'), wire('b-data', regA.id, 'out', regB.id, 'data'),
    wire('write-a', syncButton.id, 'fire', regA.id, 'write'), wire('write-b', syncButton.id, 'fire', regB.id, 'write'),
  ]);
  compute.activateResearchNode(synchronous, syncButton.id);
  assert.strictEqual(output(synchronous, regA.id).value, 2);
  assert.strictEqual(output(synchronous, regB.id).value, 1, 'registers in one pulse batch must sample old state synchronously');

  const edgeToggle = node('edge-toggle', 'toggle', { initial: false });
  const edgeDetector = node('edge-detector', 'edge-detector');
  const edgeCounter = node('edge-counter', 'counter', { initial: { type: 'number', value: 0 }, overflow: 'wrap' });
  const edgeRun = run([edgeToggle, edgeDetector, edgeCounter], [
    wire('toggle-edge', edgeToggle.id, 'out', edgeDetector.id, 'in'),
    wire('change-inc', edgeDetector.id, 'change', edgeCounter.id, 'inc'),
  ]);
  compute.activateResearchNode(edgeRun, edgeToggle.id);
  compute.activateResearchNode(edgeRun, edgeToggle.id);
  assert.strictEqual(output(edgeRun, edgeCounter.id).value, 2, 'Edge Detector must emit one change Pulse per boolean transition');
  const loopCounter = node('loop-counter', 'counter', { initial: { type: 'bits', width: 1, value: '0x0' }, overflow: 'wrap' });
  const loopEdge = node('loop-edge', 'edge-detector');
  const instantLoop = run([loopCounter, loopEdge], [
    wire('loop-value', loopCounter.id, 'out', loopEdge.id, 'in'),
    wire('loop-pulse', loopEdge.id, 'change', loopCounter.id, 'inc'),
  ]);
  assert(instantLoop.result.errors.some((error) => error.code === 'instant-event-cycle'),
    'instant event feedback loops must be rejected during compilation');

  const start = node('start', 'button');
  const pause = node('pause', 'button');
  const reset = node('reset', 'button');
  const timer = node('timer', 'timer', { mode: 'countdown', durationMs: 1000, precisionMs: 100 }, { statePolicy: 'persist' });
  const counter = node('counter', 'counter', { initial: { type: 'bits', width: 4, value: '0x0' }, overflow: 'wrap' }, { statePolicy: 'persist' });
  const timerRun = run([start, pause, reset, timer, counter], [
    wire('start-timer', start.id, 'fire', timer.id, 'start'), wire('pause-timer', pause.id, 'fire', timer.id, 'pause'),
    wire('reset-timer', reset.id, 'fire', timer.id, 'reset'), wire('done-counter', timer.id, 'done', counter.id, 'inc'),
  ]);
  compute.activateResearchNode(timerRun, start.id);
  assert.strictEqual(output(timerRun, timer.id, 'running').value, true);
  compute.snapshotPersistentResearchState(timerRun);
  compute.advanceResearchTime(timerRun, 400);
  assert.strictEqual(timerRun.persistentDirty, false, 'display refreshes must not trigger per-tick persistence');
  compute.activateResearchNode(timerRun, pause.id);
  assert.strictEqual(timerRun.persistentDirty, true, 'discrete persistent state changes must request a save');
  compute.advanceResearchTime(timerRun, 900);
  assert.strictEqual(output(timerRun, timer.id, 'time').value, 600, 'paused timer must not advance');
  compute.activateResearchNode(timerRun, start.id);
  compute.advanceResearchTime(timerRun, 1500);
  assert.strictEqual(output(timerRun, timer.id, 'time').value, 0);
  assert.strictEqual(output(timerRun, counter.id).value, '0x1', 'Timer done pulse must drive Counter');
  const savedState = compute.snapshotPersistentResearchState(timerRun);
  assert(savedState[timer.id] && savedState[counter.id], 'explicitly persistent states must be captured');
  compute.resetResearchComputeRuntime(timerRun);
  assert.strictEqual(output(timerRun, counter.id).value, '0x0');

  const fa = {
    a: node('fa-a', 'constant', { value: { type: 'boolean', value: true } }),
    b: node('fa-b', 'constant', { value: { type: 'boolean', value: true } }),
    cin: node('fa-cin', 'constant', { value: { type: 'boolean', value: true } }),
    xor1: node('fa-xor-1', 'logic', { operation: 'xor' }),
    sum: node('fa-sum', 'logic', { operation: 'xor' }),
    and1: node('fa-and-1', 'logic', { operation: 'and' }),
    and2: node('fa-and-2', 'logic', { operation: 'and' }),
    carry: node('fa-carry', 'logic', { operation: 'or' }),
  };
  const fullAdder = run(Object.values(fa), [
    wire('fa-a-xor', fa.a.id, 'out', fa.xor1.id, 'a'), wire('fa-b-xor', fa.b.id, 'out', fa.xor1.id, 'b'),
    wire('fa-xor-sum', fa.xor1.id, 'out', fa.sum.id, 'a'), wire('fa-cin-sum', fa.cin.id, 'out', fa.sum.id, 'b'),
    wire('fa-a-and', fa.a.id, 'out', fa.and1.id, 'a'), wire('fa-b-and', fa.b.id, 'out', fa.and1.id, 'b'),
    wire('fa-xor-and', fa.xor1.id, 'out', fa.and2.id, 'a'), wire('fa-cin-and', fa.cin.id, 'out', fa.and2.id, 'b'),
    wire('fa-and1-or', fa.and1.id, 'out', fa.carry.id, 'a'), wire('fa-and2-or', fa.and2.id, 'out', fa.carry.id, 'b'),
  ]);
  assert.strictEqual(output(fullAdder, fa.sum.id).value, true);
  assert.strictEqual(output(fullAdder, fa.carry.id).value, true, 'public Logic nodes must compose into a full adder');

  const aluA = node('alu-a', 'constant', { value: { type: 'bits', width: 8, value: '0x0f' } });
  const aluB = node('alu-b', 'constant', { value: { type: 'bits', width: 8, value: '0x01' } });
  const aluNormalize = node('alu-normalize', 'bits', { operation: 'resize', width: 8 });
  const aluAdd = node('alu-add', 'math', { operation: 'add' });
  const aluXor = node('alu-xor', 'logic', { operation: 'xor' });
  const aluCompare = node('alu-compare', 'compare', { operation: 'greater' });
  const aluSelect = node('alu-select', 'select');
  const alu = run([aluA, aluB, aluNormalize, aluAdd, aluXor, aluCompare, aluSelect], [
    wire('alu-a-normalize', aluA.id, 'out', aluNormalize.id, 'a'),
    wire('alu-normalize-add', aluNormalize.id, 'out', aluAdd.id, 'a'), wire('alu-b-add', aluB.id, 'out', aluAdd.id, 'b'),
    wire('alu-a-xor', aluA.id, 'out', aluXor.id, 'a'), wire('alu-b-xor', aluB.id, 'out', aluXor.id, 'b'),
    wire('alu-a-compare', aluA.id, 'out', aluCompare.id, 'a'), wire('alu-b-compare', aluB.id, 'out', aluCompare.id, 'b'),
    wire('alu-condition', aluCompare.id, 'out', aluSelect.id, 'condition'),
    wire('alu-true', aluAdd.id, 'out', aluSelect.id, 'whenTrue'), wire('alu-false', aluXor.id, 'out', aluSelect.id, 'whenFalse'),
  ]);
  assert.deepStrictEqual(output(alu, aluSelect.id), { type: 'bits', width: 8, value: '0x10' },
    'Bits, Math, Logic, Compare, and Select must compose into an 8-bit ALU slice');

  const pcClock = node('pc-clock', 'clock', { periodMs: 100 });
  const pcOne = node('pc-one', 'constant', { value: { type: 'bits', width: 4, value: '0x1' } });
  const pcAdd = node('pc-add', 'math', { operation: 'add' });
  const pcRegister = node('pc-register', 'register', { initial: { type: 'bits', width: 4, value: '0x0' } });
  const pcCounter = node('pc-counter', 'counter', { initial: { type: 'bits', width: 4, value: '0x0' }, overflow: 'wrap' });
  const pc = run([pcClock, pcOne, pcAdd, pcRegister, pcCounter], [
    wire('pc-register-add', pcRegister.id, 'out', pcAdd.id, 'a'), wire('pc-one-add', pcOne.id, 'out', pcAdd.id, 'b'),
    wire('pc-add-register', pcAdd.id, 'out', pcRegister.id, 'data'),
    wire('pc-clock-register', pcClock.id, 'tick', pcRegister.id, 'write'),
    wire('pc-clock-counter', pcClock.id, 'tick', pcCounter.id, 'inc'),
  ]);
  compute.advanceResearchTime(pc, 300);
  assert.strictEqual(output(pc, pcRegister.id).value, '0x3');
  assert.strictEqual(output(pc, pcCounter.id).value, '0x3', 'Clock, Register, Counter, and feedback must form a 4-bit datapath');

  const traceClock = node('trace-clock', 'clock', { periodMs: 100 });
  const traceCounter = node('trace-counter', 'counter', { initial: { type: 'number', value: 0 }, overflow: 'wrap' });
  const traceProbe = node('trace-probe', 'probe', { historyLimit: 16 });
  const traced = run([traceClock, traceCounter, traceProbe], [
    wire('trace-tick-counter', traceClock.id, 'tick', traceCounter.id, 'inc'),
    wire('trace-tick-probe', traceClock.id, 'tick', traceProbe.id, 'pulse'),
    wire('trace-value-probe', traceCounter.id, 'out', traceProbe.id, 'value'),
  ]);
  assert.deepStrictEqual(traced.projection[traceProbe.id].trace.map((entry) => entry.kind), ['value']);
  compute.advanceResearchTime(traced, 100);
  assert.deepStrictEqual(traced.projection[traceProbe.id].trace.map((entry) => entry.kind), ['value', 'event', 'value'],
    'Probe must preserve event-before-state-value ordering at one simulation boundary');
  assert.deepStrictEqual(traced.projection[traceProbe.id].trace.slice(1).map((entry) => entry.simulationTime), [100, 100]);
  assert.strictEqual(traced.projection[traceProbe.id].trace[1].source.nodeId, traceClock.id);
  assert.strictEqual(traced.projection[traceProbe.id].trace[2].value.value, 1);
  compute.advanceResearchTime(traced, 1800);
  assert.strictEqual(traced.projection[traceProbe.id].trace.length, 16, 'Probe history must stay within its configured bound');
  compute.clearResearchTrace(traced, traceProbe.id);
  assert.strictEqual(traced.projection[traceProbe.id].trace.length, 0, 'Probe history can be cleared without changing the graph');
  compute.resetResearchComputeRuntime(traced);
  assert.deepStrictEqual(traced.projection[traceProbe.id].trace.map((entry) => entry.kind), ['value'],
    'global reset must clear trace history and establish a fresh t=0 value baseline');

  const traceButtonA = node('trace-button-a', 'button');
  const traceButtonB = node('trace-button-b', 'button');
  const eventProbe = node('event-probe', 'probe', { historyLimit: 16 });
  const orderedTrace = run([traceButtonA, traceButtonB, eventProbe], [
    wire('trace-a-probe', traceButtonA.id, 'fire', eventProbe.id, 'pulse'),
    wire('trace-b-probe', traceButtonB.id, 'fire', eventProbe.id, 'pulse'),
  ]);
  compute.emitResearchPulses(orderedTrace, [
    { nodeId: traceButtonB.id, portId: 'fire' }, { nodeId: traceButtonA.id, portId: 'fire' },
  ]);
  assert.deepStrictEqual(orderedTrace.projection[eventProbe.id].trace.map((entry) => entry.source.nodeId),
    [traceButtonB.id, traceButtonA.id], 'multi-source event traces must follow global Pulse sequence before wire order');

  const manyNodes = [node('chain-source', 'constant', { value: { type: 'number', value: 1 } }), node('chain-zero', 'constant', { value: { type: 'number', value: 0 } })];
  const manyEdges = [];
  let previous = 'chain-source';
  for (let index = 0; index < 1500; index += 1) {
    const current = node('chain-' + index, 'math', { operation: 'add' });
    manyNodes.push(current);
    manyEdges.push(wire('left-' + index, previous, 'out', current.id, 'a'), wire('zero-' + index, 'chain-zero', 'out', current.id, 'b'));
    previous = current.id;
  }
  const large = run(manyNodes, manyEdges);
  assert.strictEqual(output(large, previous).value, 1, 'large graph execution must stay iterative');
  assert.strictEqual(large.compiled.stats.nodeCount, 1502);

  console.log('research compute regression passed');
}

main().catch((error) => { console.error(error); process.exitCode = 1; });

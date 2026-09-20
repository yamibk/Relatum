'use strict';

function typedBits(width, value) {
  return { type: 'bits', width, value };
}

function node(id, type, label, x, y, config = {}, options = {}) {
  return {
    id, type, label, x, y,
    width: options.width || 168,
    height: options.height || 80,
    config,
    statePolicy: options.statePolicy === 'persist' ? 'persist' : 'reset',
  };
}

function wire(id, fromNodeId, fromPortId, toNodeId, toPortId) {
  return {
    id,
    kind: 'wire',
    from: { nodeId: fromNodeId, portId: fromPortId },
    to: { nodeId: toNodeId, portId: toPortId },
  };
}

function page(id, title, nodes, edges, options = {}) {
  return {
    id,
    title,
    nodes,
    edges,
    view: options.view || { x: 42, y: 42, scale: 0.72 },
    simulation: { speed: options.speed || 1 },
  };
}

function fullAdderPage() {
  const nodes = [
    node('fa-a', 'constant', 'A = 1', 0, 0, { value: { type: 'boolean', value: true } }),
    node('fa-b', 'constant', 'B = 1', 0, 150, { value: { type: 'boolean', value: true } }),
    node('fa-cin', 'constant', 'Cin = 1', 0, 300, { value: { type: 'boolean', value: true } }),
    node('fa-xor-1', 'logic', 'A XOR B', 250, 45, { operation: 'xor' }),
    node('fa-and-1', 'logic', 'A AND B', 250, 205, { operation: 'and' }),
    node('fa-sum', 'logic', 'SUM', 500, 0, { operation: 'xor' }),
    node('fa-and-2', 'logic', 'Cin AND (A XOR B)', 500, 160, { operation: 'and' }),
    node('fa-carry', 'logic', 'CARRY', 750, 160, { operation: 'or' }),
    node('fa-sum-monitor', 'monitor', 'SUM 监视', 750, 0),
    node('fa-carry-monitor', 'monitor', 'CARRY 监视', 1000, 160),
  ];
  const edges = [
    wire('fa-a-xor', 'fa-a', 'out', 'fa-xor-1', 'a'),
    wire('fa-b-xor', 'fa-b', 'out', 'fa-xor-1', 'b'),
    wire('fa-xor-sum', 'fa-xor-1', 'out', 'fa-sum', 'a'),
    wire('fa-cin-sum', 'fa-cin', 'out', 'fa-sum', 'b'),
    wire('fa-a-and', 'fa-a', 'out', 'fa-and-1', 'a'),
    wire('fa-b-and', 'fa-b', 'out', 'fa-and-1', 'b'),
    wire('fa-xor-and', 'fa-xor-1', 'out', 'fa-and-2', 'a'),
    wire('fa-cin-and', 'fa-cin', 'out', 'fa-and-2', 'b'),
    wire('fa-carry-left', 'fa-and-1', 'out', 'fa-carry', 'a'),
    wire('fa-carry-right', 'fa-and-2', 'out', 'fa-carry', 'b'),
    wire('fa-sum-view', 'fa-sum', 'out', 'fa-sum-monitor', 'in'),
    wire('fa-carry-view', 'fa-carry', 'out', 'fa-carry-monitor', 'in'),
  ];
  return page('acceptance-full-adder', '全加器', nodes, edges);
}

function aluPage() {
  const nodes = [
    node('alu-a', 'constant', 'A = 0F', 0, 0, { value: typedBits(8, '0x0f') }),
    node('alu-b', 'constant', 'B = 01', 0, 180, { value: typedBits(8, '0x01') }),
    node('alu-resize', 'bits', '8 位归一化', 245, 0, { operation: 'resize', start: 0, width: 8 }),
    node('alu-add', 'math', 'ADD', 490, 0, { operation: 'add' }),
    node('alu-xor', 'logic', 'XOR', 490, 180, { operation: 'xor' }),
    node('alu-compare', 'compare', 'A > B', 245, 340, { operation: 'greater' }),
    node('alu-select', 'select', '根据 A > B 选择', 750, 100),
    node('alu-monitor', 'monitor', 'ALU OUT', 1000, 100),
  ];
  const edges = [
    wire('alu-a-resize', 'alu-a', 'out', 'alu-resize', 'a'),
    wire('alu-resize-add', 'alu-resize', 'out', 'alu-add', 'a'),
    wire('alu-b-add', 'alu-b', 'out', 'alu-add', 'b'),
    wire('alu-a-xor', 'alu-a', 'out', 'alu-xor', 'a'),
    wire('alu-b-xor', 'alu-b', 'out', 'alu-xor', 'b'),
    wire('alu-a-compare', 'alu-a', 'out', 'alu-compare', 'a'),
    wire('alu-b-compare', 'alu-b', 'out', 'alu-compare', 'b'),
    wire('alu-condition', 'alu-compare', 'out', 'alu-select', 'condition'),
    wire('alu-add-select', 'alu-add', 'out', 'alu-select', 'whenTrue'),
    wire('alu-xor-select', 'alu-xor', 'out', 'alu-select', 'whenFalse'),
    wire('alu-view', 'alu-select', 'out', 'alu-monitor', 'in'),
  ];
  return page('acceptance-alu', '8 位 ALU', nodes, edges);
}

function programCounterPage() {
  const nodes = [
    node('pc-clock', 'clock', 'Clock 40 ms', 0, 0, { periodMs: 40 }),
    node('pc-one', 'constant', '+1', 0, 220, { value: typedBits(4, '0x1') }),
    node('pc-add', 'math', '4 位加法', 300, 120, { operation: 'add' }),
    node('pc-register', 'register', '累加器', 590, 60, { initial: typedBits(4, '0x0') }),
    node('pc-counter', 'counter', '程序计数器', 590, 260, { initial: typedBits(4, '0x0'), overflow: 'wrap' }),
    node('pc-register-monitor', 'monitor', '累加器 OUT', 900, 60),
    node('pc-counter-monitor', 'monitor', 'PC OUT', 900, 260),
    node('pc-probe', 'probe', 'Clock / PC 轨迹', 1140, 150, { historyLimit: 64 }),
  ];
  const edges = [
    wire('pc-register-add', 'pc-register', 'out', 'pc-add', 'a'),
    wire('pc-one-add', 'pc-one', 'out', 'pc-add', 'b'),
    wire('pc-add-register', 'pc-add', 'out', 'pc-register', 'data'),
    wire('pc-clock-register', 'pc-clock', 'tick', 'pc-register', 'write'),
    wire('pc-clock-counter', 'pc-clock', 'tick', 'pc-counter', 'inc'),
    wire('pc-register-view', 'pc-register', 'out', 'pc-register-monitor', 'in'),
    wire('pc-counter-view', 'pc-counter', 'out', 'pc-counter-monitor', 'in'),
    wire('pc-counter-probe', 'pc-counter', 'out', 'pc-probe', 'value'),
    wire('pc-clock-probe', 'pc-clock', 'tick', 'pc-probe', 'pulse'),
  ];
  return page('acceptance-program-counter', '4 位累加器与 PC', nodes, edges);
}

function timerPage() {
  const nodes = [
    node('timer-start', 'button', '开始', 0, 0),
    node('timer-pause', 'button', '暂停', 0, 150),
    node('timer-reset', 'button', '复位', 0, 300),
    node('timer', 'timer', '400 ms 倒计时', 320, 110, {
      mode: 'countdown', durationMs: 400, precisionMs: 16,
    }),
    node('timer-counter', 'counter', '完成次数', 650, 230, {
      initial: { type: 'number', value: 0 }, overflow: 'wrap',
    }),
    node('timer-monitor', 'monitor', '剩余时间', 650, 20),
    node('timer-counter-monitor', 'monitor', 'done 计数', 930, 230),
  ];
  const edges = [
    wire('timer-start-wire', 'timer-start', 'fire', 'timer', 'start'),
    wire('timer-pause-wire', 'timer-pause', 'fire', 'timer', 'pause'),
    wire('timer-reset-wire', 'timer-reset', 'fire', 'timer', 'reset'),
    wire('timer-done-wire', 'timer', 'done', 'timer-counter', 'inc'),
    wire('timer-time-view', 'timer', 'time', 'timer-monitor', 'in'),
    wire('timer-counter-view', 'timer-counter', 'out', 'timer-counter-monitor', 'in'),
  ];
  return page('acceptance-timer', 'Timer 驱动 Counter', nodes, edges);
}

function buildResearchCircuitFixture() {
  const pages = [fullAdderPage(), aluPage(), programCounterPage(), timerPage()];
  return { researchVersion: 2, pages, activePageId: pages[0].id };
}

const EXPECTED = Object.freeze({
  fullAdder: { sum: '= true', carry: '= true' },
  alu: '= 10 · 8b',
  firstStep: '= 1 · 4b',
  timerDone: '= 1',
});

module.exports = {
  EXPECTED,
  buildResearchCircuitFixture,
  fullAdderPage,
  aluPage,
  programCounterPage,
  timerPage,
};

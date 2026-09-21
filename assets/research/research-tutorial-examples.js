function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
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
    id, kind: 'wire',
    from: { nodeId: fromNodeId, portId: fromPortId },
    to: { nodeId: toNodeId, portId: toPortId },
  };
}

function bits(width, value) { return { type: 'bits', width, value }; }
function value(type, raw) { return { type, value: raw }; }

const BUILDERS = Object.freeze({
  'price-discount': () => ({
    title: '价格与折扣计算',
    nodes: [
      node('price', 'constant', '单价 129', 0, 0, { value: value('number', 129) }),
      node('quantity', 'constant', '数量 3', 0, 150, { value: value('number', 3) }),
      node('subtotal', 'math', '小计', 250, 70, { operation: 'multiply' }),
      node('threshold', 'constant', '满 300', 250, 250, { value: value('number', 300) }),
      node('qualifies', 'compare', '是否满减', 510, 180, { operation: 'greater-equal' }),
      node('rate', 'constant', '九折 0.9', 510, 0, { value: value('number', 0.9) }),
      node('discounted', 'math', '折后金额', 760, 20, { operation: 'multiply' }),
      node('choose', 'select', '选择应付金额', 1010, 100),
      node('monitor', 'monitor', '应付金额', 1260, 100),
    ],
    edges: [
      wire('price-subtotal', 'price', 'out', 'subtotal', 'a'),
      wire('quantity-subtotal', 'quantity', 'out', 'subtotal', 'b'),
      wire('subtotal-compare', 'subtotal', 'out', 'qualifies', 'a'),
      wire('threshold-compare', 'threshold', 'out', 'qualifies', 'b'),
      wire('subtotal-discount', 'subtotal', 'out', 'discounted', 'a'),
      wire('rate-discount', 'rate', 'out', 'discounted', 'b'),
      wire('condition-select', 'qualifies', 'out', 'choose', 'condition'),
      wire('discount-select', 'discounted', 'out', 'choose', 'whenTrue'),
      wire('subtotal-select', 'subtotal', 'out', 'choose', 'whenFalse'),
      wire('select-monitor', 'choose', 'out', 'monitor', 'in'),
    ],
  }),
  'deadline-reminder': () => {
    const deadline = Date.now() + 60 * 60 * 1000;
    return {
      title: '截止时间提醒',
      nodes: [
        node('now', 'current-time', '当前时间', 0, 80, { precisionMs: 1000 }),
        node('deadline', 'constant', '一小时后的截止时间', 0, 250, { value: value('time', deadline) }),
        node('compare', 'compare', '是否仍未到期', 300, 160, { operation: 'less' }),
        node('lamp', 'lamp', '期限内', 590, 40),
        node('safe-copy', 'constant', '提示：仍在期限内', 590, 180, { value: value('string', '仍在期限内') }),
        node('late-copy', 'constant', '提示：已经到期', 590, 330, { value: value('string', '已经到期') }),
        node('select', 'select', '选择提示', 880, 190),
        node('monitor', 'monitor', '截止状态', 1140, 190),
      ],
      edges: [
        wire('now-compare', 'now', 'out', 'compare', 'a'),
        wire('deadline-compare', 'deadline', 'out', 'compare', 'b'),
        wire('compare-lamp', 'compare', 'out', 'lamp', 'in'),
        wire('compare-select', 'compare', 'out', 'select', 'condition'),
        wire('safe-select', 'safe-copy', 'out', 'select', 'whenTrue'),
        wire('late-select', 'late-copy', 'out', 'select', 'whenFalse'),
        wire('select-monitor', 'select', 'out', 'monitor', 'in'),
      ],
    };
  },
  'click-counter': () => ({
    title: '点击计数器',
    nodes: [
      node('button', 'button', '记一次', 0, 80),
      node('reset', 'button', '清零', 0, 240),
      node('counter', 'counter', '累计次数', 300, 140, { initial: value('number', 0), overflow: 'wrap' }),
      node('monitor', 'monitor', '当前次数', 590, 70),
      node('probe', 'probe', '点击轨迹', 590, 230, { historyLimit: 64 }),
    ],
    edges: [
      wire('button-counter', 'button', 'fire', 'counter', 'inc'),
      wire('reset-counter', 'reset', 'fire', 'counter', 'reset'),
      wire('counter-monitor', 'counter', 'out', 'monitor', 'in'),
      wire('counter-probe', 'counter', 'out', 'probe', 'value'),
      wire('button-probe', 'button', 'fire', 'probe', 'pulse'),
    ],
  }),
  'change-tracker': () => ({
    title: '状态变化记录',
    nodes: [
      node('toggle', 'toggle', '门窗状态', 0, 100, { initial: false }),
      node('edge', 'edge-detector', '检测开关变化', 280, 100),
      node('counter', 'counter', '变化次数', 560, 40, { initial: value('number', 0), overflow: 'wrap' }),
      node('lamp', 'lamp', '当前状态', 560, 200),
      node('monitor', 'monitor', '累计变化', 840, 40),
      node('probe', 'probe', '变化轨迹', 840, 200, { historyLimit: 64 }),
    ],
    edges: [
      wire('toggle-edge', 'toggle', 'out', 'edge', 'in'),
      wire('toggle-lamp', 'toggle', 'out', 'lamp', 'in'),
      wire('edge-counter', 'edge', 'change', 'counter', 'inc'),
      wire('counter-monitor', 'counter', 'out', 'monitor', 'in'),
      wire('edge-probe', 'edge', 'change', 'probe', 'pulse'),
    ],
  }),
  'focus-timer': () => ({
    title: '番茄计时器',
    nodes: [
      node('start', 'button', '开始', 0, 0),
      node('pause', 'button', '暂停', 0, 150),
      node('reset', 'button', '复位', 0, 300),
      node('timer', 'timer', '10 秒专注演示', 300, 110, { mode: 'countdown', durationMs: 10000, precisionMs: 1000 }),
      node('running', 'lamp', '正在计时', 600, 0),
      node('time', 'monitor', '剩余毫秒', 600, 150),
      node('counter', 'counter', '完成轮数', 600, 300, { initial: value('number', 0), overflow: 'wrap' }),
      node('rounds', 'monitor', '已完成轮数', 900, 300),
      node('probe', 'probe', '完成事件', 900, 80, { historyLimit: 64 }),
    ],
    edges: [
      wire('start-timer', 'start', 'fire', 'timer', 'start'),
      wire('pause-timer', 'pause', 'fire', 'timer', 'pause'),
      wire('reset-timer', 'reset', 'fire', 'timer', 'reset'),
      wire('timer-running', 'timer', 'running', 'running', 'in'),
      wire('timer-time', 'timer', 'time', 'time', 'in'),
      wire('timer-counter', 'timer', 'done', 'counter', 'inc'),
      wire('counter-rounds', 'counter', 'out', 'rounds', 'in'),
      wire('timer-probe', 'timer', 'done', 'probe', 'pulse'),
    ],
  }),
  'full-adder': () => ({
    title: '一位全加器',
    nodes: [
      node('a', 'constant', 'A = 1', 0, 0, { value: value('boolean', true) }),
      node('b', 'constant', 'B = 1', 0, 150, { value: value('boolean', true) }),
      node('cin', 'constant', 'Cin = 1', 0, 300, { value: value('boolean', true) }),
      node('xor1', 'logic', 'A XOR B', 250, 45, { operation: 'xor' }),
      node('and1', 'logic', 'A AND B', 250, 205, { operation: 'and' }),
      node('sum', 'logic', 'SUM', 500, 0, { operation: 'xor' }),
      node('and2', 'logic', 'Cin AND (A XOR B)', 500, 160, { operation: 'and' }),
      node('carry', 'logic', 'CARRY', 750, 160, { operation: 'or' }),
      node('sum-monitor', 'monitor', 'SUM 监视', 750, 0),
      node('carry-monitor', 'monitor', 'CARRY 监视', 1000, 160),
    ],
    edges: [
      wire('a-xor', 'a', 'out', 'xor1', 'a'), wire('b-xor', 'b', 'out', 'xor1', 'b'),
      wire('xor-sum', 'xor1', 'out', 'sum', 'a'), wire('cin-sum', 'cin', 'out', 'sum', 'b'),
      wire('a-and', 'a', 'out', 'and1', 'a'), wire('b-and', 'b', 'out', 'and1', 'b'),
      wire('xor-and', 'xor1', 'out', 'and2', 'a'), wire('cin-and', 'cin', 'out', 'and2', 'b'),
      wire('and-carry', 'and1', 'out', 'carry', 'a'), wire('and2-carry', 'and2', 'out', 'carry', 'b'),
      wire('sum-view', 'sum', 'out', 'sum-monitor', 'in'), wire('carry-view', 'carry', 'out', 'carry-monitor', 'in'),
    ],
  }),
  'alu-8bit': () => ({
    title: '8 位 ALU',
    nodes: [
      node('a', 'constant', 'A = 0F', 0, 0, { value: bits(8, '0x0f') }),
      node('b', 'constant', 'B = 01', 0, 180, { value: bits(8, '0x01') }),
      node('resize', 'bits', '8 位归一化', 245, 0, { operation: 'resize', start: 0, width: 8 }),
      node('add', 'math', 'ADD', 490, 0, { operation: 'add' }),
      node('xor', 'logic', 'XOR', 490, 180, { operation: 'xor' }),
      node('compare', 'compare', 'A > B', 245, 340, { operation: 'greater' }),
      node('select', 'select', '根据 A > B 选择', 750, 100),
      node('monitor', 'monitor', 'ALU OUT', 1000, 100),
    ],
    edges: [
      wire('a-resize', 'a', 'out', 'resize', 'a'), wire('resize-add', 'resize', 'out', 'add', 'a'),
      wire('b-add', 'b', 'out', 'add', 'b'), wire('a-xor', 'a', 'out', 'xor', 'a'),
      wire('b-xor', 'b', 'out', 'xor', 'b'), wire('a-compare', 'a', 'out', 'compare', 'a'),
      wire('b-compare', 'b', 'out', 'compare', 'b'), wire('condition', 'compare', 'out', 'select', 'condition'),
      wire('add-select', 'add', 'out', 'select', 'whenTrue'), wire('xor-select', 'xor', 'out', 'select', 'whenFalse'),
      wire('view', 'select', 'out', 'monitor', 'in'),
    ],
  }),
  'program-counter': () => ({
    title: '4 位累加器与程序计数器',
    nodes: [
      node('clock', 'clock', 'Clock 250 ms', 0, 0, { periodMs: 250 }),
      node('one', 'constant', '+1', 0, 220, { value: bits(4, '0x1') }),
      node('add', 'math', '4 位加法', 300, 120, { operation: 'add' }),
      node('register', 'register', '累加器', 590, 60, { initial: bits(4, '0x0') }),
      node('counter', 'counter', '程序计数器', 590, 260, { initial: bits(4, '0x0'), overflow: 'wrap' }),
      node('register-monitor', 'monitor', '累加器 OUT', 900, 60),
      node('counter-monitor', 'monitor', 'PC OUT', 900, 260),
      node('probe', 'probe', 'Clock / PC 轨迹', 1140, 150, { historyLimit: 64 }),
    ],
    edges: [
      wire('register-add', 'register', 'out', 'add', 'a'), wire('one-add', 'one', 'out', 'add', 'b'),
      wire('add-register', 'add', 'out', 'register', 'data'), wire('clock-register', 'clock', 'tick', 'register', 'write'),
      wire('clock-counter', 'clock', 'tick', 'counter', 'inc'), wire('register-view', 'register', 'out', 'register-monitor', 'in'),
      wire('counter-view', 'counter', 'out', 'counter-monitor', 'in'), wire('counter-probe', 'counter', 'out', 'probe', 'value'),
      wire('clock-probe', 'clock', 'tick', 'probe', 'pulse'),
    ],
  }),
});

export const RESEARCH_TUTORIAL_EXAMPLE_IDS = Object.freeze(Object.keys(BUILDERS));

export function buildResearchTutorialExample(exampleId) {
  const builder = BUILDERS[String(exampleId || '')];
  return builder ? clone(builder()) : null;
}


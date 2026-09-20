import {
  bitsBigInt, bitsValue, copyResearchValue, sameResearchValue, truthyResearchValue,
} from './research-values.js';

const STATE_TYPES = new Set(['toggle', 'clock', 'register', 'counter', 'edge-detector', 'timer']);
const MAX_PULSES_PER_BATCH = 1000;
const MAX_EVALUATIONS_PER_BATCH = 10000;

function errorValue(code, message, extra = {}) {
  return { type: 'error', code, message, ...extra };
}

function nowMilliseconds() {
  return globalThis.performance && typeof globalThis.performance.now === 'function'
    ? globalThis.performance.now() : Date.now();
}

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function stateSignature(node) {
  return node.type + ':' + JSON.stringify(node.config || {}) + ':' + node.statePolicy;
}

function portKey(nodeId, portId) {
  return String(nodeId) + '\n' + String(portId);
}

function projectionItem() {
  return { status: 'idle', inputs: {}, outputs: {}, output: null, error: null, lastPulse: null };
}

function probeLimit(node) {
  return Math.min(256, Math.max(16, Number(node && node.config && node.config.historyLimit) || 64));
}

function traceSource(runtime, nodeId, portId) {
  const node = runtime.compiled.nodeById.get(String(nodeId));
  return { nodeId: String(nodeId), portId: String(portId), label: node ? String(node.label || node.id) : String(nodeId) };
}

function ensureProbeTrace(runtime, nodeId) {
  nodeId = String(nodeId);
  let record = runtime.traceByNodeId.get(nodeId);
  if (!record) {
    record = { entries: [], lastValue: null, lastSourceKey: '' };
    runtime.traceByNodeId.set(nodeId, record);
  }
  const limit = probeLimit(runtime.compiled.nodeById.get(nodeId));
  if (record.entries.length > limit) record.entries.splice(0, record.entries.length - limit);
  return record;
}

function syncProbeTraces(runtime) {
  const live = new Set(Array.from(runtime.compiled.nodeById.values())
    .filter((node) => node.type === 'probe').map((node) => String(node.id)));
  runtime.traceByNodeId.forEach((_record, nodeId) => { if (!live.has(nodeId)) runtime.traceByNodeId.delete(nodeId); });
  live.forEach((nodeId) => ensureProbeTrace(runtime, nodeId));
}

function pushProbeTrace(runtime, nodeId, entry) {
  const node = runtime.compiled.nodeById.get(String(nodeId));
  if (!node || node.type !== 'probe') return null;
  const record = ensureProbeTrace(runtime, nodeId);
  const item = { ...entry, order: ++runtime.traceOrder, wallTime: runtime.wallTime };
  record.entries.push(item);
  const limit = probeLimit(node);
  if (record.entries.length > limit) record.entries.splice(0, record.entries.length - limit);
  return item;
}

function exposeProbeTrace(runtime, nodeId, item = null) {
  const node = runtime.compiled.nodeById.get(String(nodeId));
  if (!node || node.type !== 'probe') return;
  const projection = item || runtime.projection[nodeId] || (runtime.projection[nodeId] = projectionItem());
  const record = ensureProbeTrace(runtime, nodeId);
  projection.trace = record.entries.map((entry) => clone(entry));
  projection.traceLimit = probeLimit(node);
  if (projection.trace.length && !projection.error) projection.status = 'ok';
}

function observeProbeValue(runtime, node, item, value) {
  const record = ensureProbeTrace(runtime, node.id);
  const edge = runtime.compiled.incomingValues.get(node.id).get('value');
  if (!value || !edge) {
    record.lastValue = null; record.lastSourceKey = ''; exposeProbeTrace(runtime, node.id, item); return;
  }
  const sourceKey = edge.fromId + '\n' + edge.fromPortId;
  if (!sameResearchValue(record.lastValue, value) || record.lastSourceKey !== sourceKey) {
    pushProbeTrace(runtime, node.id, {
      kind: 'value', simulationTime: runtime.simulationTime, sequence: runtime.sequence,
      source: traceSource(runtime, edge.fromId, edge.fromPortId), value: copyResearchValue(value),
    });
    record.lastValue = copyResearchValue(value); record.lastSourceKey = sourceKey;
  }
  item.output = copyResearchValue(value);
  exposeProbeTrace(runtime, node.id, item);
}

function observeProbeEvent(runtime, delivery) {
  const node = runtime.compiled.nodeById.get(delivery.toId);
  if (!node || node.type !== 'probe' || delivery.toPortId !== 'pulse') return;
  pushProbeTrace(runtime, node.id, {
    kind: 'event', simulationTime: delivery.pulse.simulationTime, sequence: delivery.pulse.sequence,
    source: traceSource(runtime, delivery.fromId, delivery.fromPortId),
  });
  exposeProbeTrace(runtime, node.id);
}

function createStateRecord(node, simulationTime = 0, allowSaved = true) {
  const saved = allowSaved && node.statePolicy === 'persist' && node.savedState && typeof node.savedState === 'object'
    ? node.savedState : {};
  const signature = stateSignature(node);
  if (node.type === 'toggle') return { signature, current: typeof saved.current === 'boolean' ? saved.current : !!node.config.initial };
  if (node.type === 'clock') {
    const period = Math.max(16, Number(node.config.periodMs) || 1000);
    const remaining = Number.isFinite(Number(saved.remainingMs)) ? Math.max(0, Number(saved.remainingMs)) : period;
    return { signature, nextTick: simulationTime + remaining };
  }
  if (node.type === 'register') {
    const initial = copyResearchValue(node.config.initial);
    const restored = copyResearchValue(saved.current);
    return { signature, current: restored && sameType(restored, initial) ? restored : initial };
  }
  if (node.type === 'counter') {
    const initial = copyResearchValue(node.config.initial);
    const restored = copyResearchValue(saved.current);
    return { signature, current: restored && sameType(restored, initial) ? restored : initial };
  }
  if (node.type === 'edge-detector') return { signature, previous: saved.previous === true };
  if (node.type === 'timer') {
    const durationMs = Math.max(1, Number(saved.durationMs) || Number(node.config.durationMs) || 1500000);
    return {
      signature,
      durationMs,
      elapsedMs: Math.min(durationMs, Math.max(0, Number(saved.elapsedMs) || 0)),
      running: saved.running === true,
      done: saved.done === true,
    };
  }
  return null;
}

function syncStateRecords(compiled, target, simulationTime, allowSaved = true) {
  const live = new Set(compiled.stateNodeIds);
  target.forEach((_value, nodeId) => { if (!live.has(nodeId)) target.delete(nodeId); });
  compiled.stateNodeIds.forEach((nodeId) => {
    const node = compiled.nodeById.get(nodeId);
    const current = target.get(nodeId);
    const signature = stateSignature(node);
    if (!current || current.signature !== signature) target.set(nodeId, createStateRecord(node, simulationTime, allowSaved));
  });
  return target;
}

export function compileResearchGraph(source = {}, registry) {
  if (!registry) throw new TypeError('编译研究图需要节点注册表');
  const nodes = Array.isArray(source.nodes) ? source.nodes : [];
  const edges = Array.isArray(source.edges) ? source.edges : [];
  const nodeById = new Map();
  const incomingValues = new Map();
  const outgoingValues = new Map();
  const outgoingEvents = new Map();
  const errors = [];
  nodes.forEach((node) => {
    if (!node || !node.id) return;
    const id = String(node.id);
    nodeById.set(id, node);
    incomingValues.set(id, new Map());
    outgoingValues.set(id, []);
    outgoingEvents.set(id, new Map());
    if (!registry.definition(node.type)) errors.push(errorValue('unsupported-node-type', '不支持的节点：' + node.type, { nodeId: id }));
  });
  let wireCount = 0;
  let relationCount = 0;
  edges.forEach((edge, index) => {
    if (!edge) return;
    if (edge.kind !== 'wire') { relationCount += 1; return; }
    wireCount += 1;
    const fromId = String(edge.from && edge.from.nodeId || '');
    const toId = String(edge.to && edge.to.nodeId || '');
    const fromPortId = String(edge.from && edge.from.portId || '');
    const toPortId = String(edge.to && edge.to.portId || '');
    const fromNode = nodeById.get(fromId); const toNode = nodeById.get(toId);
    const fromPort = fromNode && registry.port(fromNode.type, fromPortId, 'output');
    const toPort = toNode && registry.port(toNode.type, toPortId, 'input');
    if (!fromNode || !toNode || !fromPort || !toPort || !registry.compatiblePorts(fromNode, fromPortId, toNode, toPortId)) {
      errors.push(errorValue('incompatible-wire', '导线端口不兼容', { edgeId: String(edge.id || ''), nodeId: toId || fromId }));
      return;
    }
    const compiledEdge = { edgeId: String(edge.id || ''), order: index, fromId, toId, fromPortId, toPortId, channel: fromPort.channel };
    if (fromPort.channel === 'event') {
      if (!outgoingEvents.get(fromId).has(fromPortId)) outgoingEvents.get(fromId).set(fromPortId, []);
      outgoingEvents.get(fromId).get(fromPortId).push(compiledEdge);
      return;
    }
    if (incomingValues.get(toId).has(toPortId)) {
      errors.push(errorValue('duplicate-value-input', '值输入端口只能连接一条导线', { edgeId: compiledEdge.edgeId, nodeId: toId, portId: toPortId }));
      return;
    }
    incomingValues.get(toId).set(toPortId, compiledEdge);
    outgoingValues.get(fromId).push(compiledEdge);
  });

  const indegree = new Map();
  nodeById.forEach((_node, nodeId) => indegree.set(nodeId, 0));
  outgoingValues.forEach((list) => list.forEach((edge) => {
    const target = nodeById.get(edge.toId);
    if (!target || STATE_TYPES.has(target.type)) return;
    indegree.set(edge.toId, (indegree.get(edge.toId) || 0) + 1);
  }));
  const queue = [];
  nodeById.forEach((_node, nodeId) => { if ((indegree.get(nodeId) || 0) === 0) queue.push(nodeId); });
  const order = [];
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const nodeId = queue[cursor];
    order.push(nodeId);
    (outgoingValues.get(nodeId) || []).forEach((edge) => {
      const target = nodeById.get(edge.toId);
      if (!target || STATE_TYPES.has(target.type)) return;
      const next = (indegree.get(edge.toId) || 0) - 1;
      indegree.set(edge.toId, next);
      if (next === 0) queue.push(edge.toId);
    });
  }
  if (order.length !== nodeById.size) {
    nodeById.forEach((_node, nodeId) => {
      if ((indegree.get(nodeId) || 0) > 0) errors.push(errorValue('combinational-cycle', '组合逻辑环必须经过寄存器或其他状态边界', { nodeId }));
    });
  }
  const causal = new Map();
  nodeById.forEach((_node, nodeId) => causal.set(nodeId, []));
  outgoingValues.forEach((list, fromId) => list.forEach((edge) => {
    const target = nodeById.get(edge.toId);
    if (target && (!STATE_TYPES.has(target.type) || target.type === 'edge-detector')) {
      causal.get(fromId).push({ to: edge.toId, channel: 'value' });
    }
  }));
  outgoingEvents.forEach((byPort, fromId) => byPort.forEach((list) => list.forEach((edge) => {
    causal.get(fromId).push({ to: edge.toId, channel: 'event' });
  })));
  const color = new Map();
  const activeIndex = new Map();
  const reportedEventCycles = new Set();
  nodeById.forEach((_node, startId) => {
    if (color.get(startId)) return;
    const stack = [{ nodeId: startId, edgeIndex: 0, incomingChannel: '' }];
    color.set(startId, 1); activeIndex.set(startId, 0);
    while (stack.length) {
      const frame = stack[stack.length - 1];
      const edgesFromNode = causal.get(frame.nodeId) || [];
      if (frame.edgeIndex >= edgesFromNode.length) {
        color.set(frame.nodeId, 2); activeIndex.delete(frame.nodeId); stack.pop(); continue;
      }
      const edge = edgesFromNode[frame.edgeIndex++];
      if (!color.get(edge.to)) {
        color.set(edge.to, 1); activeIndex.set(edge.to, stack.length);
        stack.push({ nodeId: edge.to, edgeIndex: 0, incomingChannel: edge.channel });
        continue;
      }
      if (color.get(edge.to) !== 1) continue;
      const cycleStart = activeIndex.get(edge.to);
      const hasEvent = edge.channel === 'event'
        || stack.slice(cycleStart + 1).some((item) => item.incomingChannel === 'event');
      if (!hasEvent) continue;
      const cycleIds = stack.slice(cycleStart).map((item) => item.nodeId);
      const cycleKey = cycleIds.slice().sort().join('\n');
      if (reportedEventCycles.has(cycleKey)) continue;
      reportedEventCycles.add(cycleKey);
      errors.push(errorValue('instant-event-cycle', '即时事件环必须增加可控时间或状态边界', {
        nodeId: edge.to, nodeIds: cycleIds,
      }));
    }
  });
  const stateNodeIds = Array.from(nodeById.values()).filter((node) => STATE_TYPES.has(node.type)).map((node) => String(node.id));
  return {
    registry, nodeById, incomingValues, outgoingValues, outgoingEvents, order, errors, stateNodeIds,
    stats: { nodeCount: nodeById.size, wireCount, relationCount, stateNodeCount: stateNodeIds.length },
  };
}

function readInput(runtime, nodeId, portId) {
  const edge = runtime.compiled.incomingValues.get(nodeId).get(portId);
  return edge ? copyResearchValue(runtime.portValues.get(portKey(edge.fromId, edge.fromPortId))) : null;
}

function setOutput(runtime, nodeId, portId, value) {
  const key = portKey(nodeId, portId);
  const next = copyResearchValue(value);
  const previous = runtime.portValues.get(key);
  if (next) runtime.portValues.set(key, next); else runtime.portValues.delete(key);
  return !sameResearchValue(previous, next);
}

function typedError(nodeId, message, portId = '') {
  return errorValue('type-mismatch', message, { nodeId, portId });
}

function requireInputs(node, item, inputs, required) {
  for (const portId of required) {
    if (!inputs[portId]) {
      item.status = 'idle';
      item.error = errorValue('missing-input', '缺少输入：' + portId, { nodeId: node.id, portId });
      return false;
    }
  }
  return true;
}

function sameType(left, right) {
  return !!left && !!right && left.type === right.type
    && (left.type !== 'bits' || left.width === right.width);
}

function evaluateMath(node, inputs) {
  const a = inputs.a; const b = inputs.b; const operation = node.config.operation;
  if (!sameType(a, b) || !['number', 'bits'].includes(a.type)) return typedError(node.id, '数学运算需要同类型、同位宽的 number 或 bits');
  if (a.type === 'number') {
    if ((operation === 'divide' || operation === 'modulo') && b.value === 0) return errorValue('divide-by-zero', '除数不能为零', { nodeId: node.id });
    const value = operation === 'add' ? a.value + b.value
      : operation === 'subtract' ? a.value - b.value
        : operation === 'multiply' ? a.value * b.value
          : operation === 'divide' ? a.value / b.value : a.value % b.value;
    return Number.isFinite(value) ? { type: 'number', value } : errorValue('invalid-result', '运算结果不是有限数值', { nodeId: node.id });
  }
  const left = bitsBigInt(a); const right = bitsBigInt(b);
  if ((operation === 'divide' || operation === 'modulo') && right === 0n) return errorValue('divide-by-zero', '除数不能为零', { nodeId: node.id });
  const value = operation === 'add' ? left + right
    : operation === 'subtract' ? left - right
      : operation === 'multiply' ? left * right
        : operation === 'divide' ? left / right : left % right;
  return bitsValue(a.width, value);
}

function evaluateLogic(node, inputs) {
  const a = inputs.a; const b = inputs.b; const operation = node.config.operation;
  if (!a || !['boolean', 'bits'].includes(a.type)) return typedError(node.id, '逻辑运算需要 boolean 或 bits');
  if (operation !== 'not' && !sameType(a, b)) return typedError(node.id, '二元逻辑运算需要同类型、同位宽输入');
  if (a.type === 'boolean') {
    return { type: 'boolean', value: operation === 'not' ? !a.value
      : operation === 'and' ? a.value && b.value : operation === 'or' ? a.value || b.value : a.value !== b.value };
  }
  const left = bitsBigInt(a); const right = b ? bitsBigInt(b) : 0n;
  return bitsValue(a.width, operation === 'not' ? ~left
    : operation === 'and' ? left & right : operation === 'or' ? left | right : left ^ right);
}

function evaluateCompare(node, inputs) {
  const a = inputs.a; const b = inputs.b; const operation = node.config.operation;
  if (!sameType(a, b)) return typedError(node.id, '比较需要同类型、同位宽输入');
  const left = a.type === 'bits' ? bitsBigInt(a) : a.value;
  const right = b.type === 'bits' ? bitsBigInt(b) : b.value;
  const value = operation === 'equal' ? left === right : operation === 'not-equal' ? left !== right
    : operation === 'less' ? left < right : operation === 'less-equal' ? left <= right
      : operation === 'greater' ? left > right : left >= right;
  return { type: 'boolean', value };
}

function evaluateConvert(node, input) {
  const toType = node.config.toType;
  if (!input) return null;
  if (toType === input.type && toType !== 'bits') return copyResearchValue(input);
  if (toType === 'string') return { type: 'string', value: input.type === 'bits' ? input.value : String(input.value) };
  if (toType === 'boolean') {
    if (input.type === 'number') return { type: 'boolean', value: input.value !== 0 };
    if (input.type === 'bits' && input.width === 1) return { type: 'boolean', value: bitsBigInt(input) === 1n };
    if (input.type === 'string' && (input.value === 'true' || input.value === 'false')) return { type: 'boolean', value: input.value === 'true' };
  }
  if (toType === 'number') {
    if (input.type === 'boolean') return { type: 'number', value: input.value ? 1 : 0 };
    if (input.type === 'bits') return { type: 'number', value: Number(bitsBigInt(input)) };
    if (input.type === 'string' && input.value.trim() !== '' && Number.isFinite(Number(input.value))) return { type: 'number', value: Number(input.value) };
  }
  if (toType === 'bits') {
    if (input.type === 'number' && Number.isSafeInteger(input.value)) return bitsValue(node.config.width, BigInt(input.value));
    if (input.type === 'boolean') return bitsValue(node.config.width, input.value ? 1n : 0n);
    if (input.type === 'bits') return bitsValue(node.config.width, bitsBigInt(input));
  }
  return errorValue('invalid-conversion', '无法完成显式类型转换', { nodeId: node.id });
}

function evaluateBits(node, inputs) {
  const a = inputs.a; const b = inputs.b; const operation = node.config.operation;
  if (!a || a.type !== 'bits') return typedError(node.id, 'Bits 操作的 a 必须是 bits');
  const left = bitsBigInt(a);
  if (operation === 'shift-left' || operation === 'shift-right') {
    if (!b || b.type !== 'number' || !Number.isSafeInteger(b.value) || b.value < 0) return typedError(node.id, '移位量必须是非负安全整数');
    return bitsValue(a.width, operation === 'shift-left' ? left << BigInt(b.value) : left >> BigInt(b.value));
  }
  if (operation === 'concat') {
    if (!b || b.type !== 'bits' || a.width + b.width > 64) return typedError(node.id, 'Concat 需要两个 bits，总位宽不得超过 64');
    return bitsValue(a.width + b.width, (left << BigInt(b.width)) | bitsBigInt(b));
  }
  if (operation === 'slice') {
    const start = Number(node.config.start) || 0; const width = Number(node.config.width) || 1;
    if (start + width > a.width) return errorValue('invalid-bit-range', '切片范围超出输入位宽', { nodeId: node.id });
    return bitsValue(width, left >> BigInt(start));
  }
  return bitsValue(node.config.width, left);
}

function evaluateNode(runtime, nodeId) {
  const node = runtime.compiled.nodeById.get(nodeId);
  const definition = node && runtime.registry.definition(node.type);
  const item = projectionItem();
  runtime.projection[nodeId] = item;
  if (!node || !definition) return;
  const inputs = {};
  definition.ports.filter((port) => port.direction === 'input' && port.channel === 'value')
    .forEach((port) => { const value = readInput(runtime, nodeId, port.id); if (value) inputs[port.id] = value; });
  item.inputs = inputs;
  let required = definition.ports.filter((port) => port.direction === 'input' && port.channel === 'value' && port.required).map((port) => port.id);
  if (node.type === 'register') required = [];
  if (node.type === 'logic' && node.config.operation === 'not') required = required.filter((port) => port !== 'b');
  if (node.type === 'bits' && ['slice', 'resize'].includes(node.config.operation)) required = required.filter((port) => port !== 'b');
  if (!requireInputs(node, item, inputs, required)) return;
  let outputs = {};
  if (node.type === 'constant') outputs.out = copyResearchValue(node.config.value);
  else if (node.type === 'toggle') outputs.out = { type: 'boolean', value: !!runtime.stateByNodeId.get(nodeId).current };
  else if (node.type === 'current-time') {
    const precision = Math.max(250, Number(node.config.precisionMs) || 1000);
    outputs.out = { type: 'time', value: Math.floor(runtime.wallTime / precision) * precision };
  } else if (node.type === 'math') outputs.out = evaluateMath(node, inputs);
  else if (node.type === 'logic') outputs.out = evaluateLogic(node, inputs);
  else if (node.type === 'compare') outputs.out = evaluateCompare(node, inputs);
  else if (node.type === 'select') {
    if (!inputs.condition || inputs.condition.type !== 'boolean' || !sameType(inputs.whenTrue, inputs.whenFalse)) {
      outputs.out = typedError(node.id, '选择节点需要 boolean 条件和同类型分支');
    } else outputs.out = copyResearchValue(inputs.condition.value ? inputs.whenTrue : inputs.whenFalse);
  } else if (node.type === 'convert') outputs.out = evaluateConvert(node, inputs.in);
  else if (node.type === 'bits') outputs.out = evaluateBits(node, inputs);
  else if (node.type === 'register') outputs.out = copyResearchValue(runtime.stateByNodeId.get(nodeId).current);
  else if (node.type === 'counter') outputs.out = copyResearchValue(runtime.stateByNodeId.get(nodeId).current);
  else if (node.type === 'timer') {
    const state = runtime.stateByNodeId.get(nodeId);
    const raw = node.config.mode === 'countdown' ? Math.max(0, state.durationMs - state.elapsedMs) : Math.min(state.durationMs, state.elapsedMs);
    const precision = Math.max(16, Number(node.config.precisionMs) || 1000);
    outputs.time = { type: 'number', value: node.config.mode === 'countdown'
      ? Math.ceil(raw / precision) * precision : Math.floor(raw / precision) * precision };
    outputs.running = { type: 'boolean', value: state.running };
  } else if (node.type === 'monitor' || node.type === 'lamp') outputs.display = copyResearchValue(inputs.in);
  else if (node.type === 'probe') observeProbeValue(runtime, node, item, inputs.value);
  Object.entries(outputs).forEach(([portId, value]) => {
    if (value && value.type === 'error') { item.status = 'error'; item.error = value; item.output = value; return; }
    if (value) { setOutput(runtime, nodeId, portId, value); item.outputs[portId] = copyResearchValue(value); if (!item.output) item.output = copyResearchValue(value); }
  });
  if (!item.error && Object.keys(item.outputs).length) item.status = 'ok';
}

function downstreamClosure(compiled, dirtyIds) {
  const affected = new Set(); const queue = [];
  dirtyIds.forEach((id) => { id = String(id); if (compiled.nodeById.has(id) && !affected.has(id)) { affected.add(id); queue.push(id); } });
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    (compiled.outgoingValues.get(queue[cursor]) || []).forEach((edge) => {
      if (!affected.has(edge.toId)) { affected.add(edge.toId); queue.push(edge.toId); }
    });
  }
  return affected;
}

function collectEdgeDetectorPulses(runtime, affected, initialize = false) {
  const pulses = [];
  runtime.compiled.stateNodeIds.forEach((nodeId) => {
    const node = runtime.compiled.nodeById.get(nodeId);
    if (node.type !== 'edge-detector' || affected && !affected.has(nodeId)) return;
    const input = readInput(runtime, nodeId, 'in');
    if (!input || (input.type !== 'boolean' && !(input.type === 'bits' && input.width === 1))) return;
    const current = truthyResearchValue(input); const record = runtime.stateByNodeId.get(nodeId);
    const previous = record.previous;
    record.previous = current;
    if (initialize || current === previous) return;
    pulses.push({ nodeId, portId: current ? 'rise' : 'fall' }, { nodeId, portId: 'change' });
    runtime.persistentDirty ||= runtime.compiled.nodeById.get(nodeId).statePolicy === 'persist';
  });
  return pulses;
}

function recompute(runtime, dirtyIds = null, options = {}) {
  const affected = dirtyIds ? downstreamClosure(runtime.compiled, dirtyIds) : new Set(runtime.compiled.nodeById.keys());
  let evaluated = 0;
  runtime.compiled.order.forEach((nodeId) => {
    if (!affected.has(nodeId)) return;
    evaluateNode(runtime, nodeId); evaluated += 1;
  });
  runtime.counters.evaluatedNodeCount += evaluated;
  if (runtime.batchEvaluations != null) runtime.batchEvaluations += evaluated;
  const pulses = collectEdgeDetectorPulses(runtime, affected, options.initializeEdges === true);
  runtime.result = buildResult(runtime, { affectedNodeCount: affected.size, evaluatedNodeCount: evaluated });
  return pulses;
}

function buildResult(runtime, extra = {}) {
  const errors = runtime.compiled.errors.slice();
  if (runtime.runtimeError) errors.push(runtime.runtimeError);
  Object.values(runtime.projection).forEach((item) => { if (item && item.error && item.error.code !== 'missing-input') errors.push(item.error); });
  return {
    ok: !errors.length,
    projection: runtime.projection,
    errors,
    order: runtime.compiled.order.slice(),
    stats: { ...runtime.compiled.stats, ...runtime.counters, simulationTime: runtime.simulationTime, ...extra },
  };
}

function cloneStateRecord(record) { return clone(record); }

function applyEventToStage(runtime, delivery, staged) {
  const node = runtime.compiled.nodeById.get(delivery.toId);
  if (!node || !STATE_TYPES.has(node.type)) return;
  const original = runtime.stateByNodeId.get(node.id);
  const state = staged.get(node.id) || cloneStateRecord(original);
  const port = delivery.toPortId;
  if (node.type === 'register') {
    if (port === 'reset') state.current = copyResearchValue(node.config.initial);
    else if (port === 'write') { const value = readInput(runtime, node.id, 'data'); if (value) state.current = value; }
  } else if (node.type === 'counter') {
    if (port === 'reset') state.current = copyResearchValue(node.config.initial);
    else if (port === 'load') { const value = readInput(runtime, node.id, 'loadValue'); if (value && ['number', 'bits'].includes(value.type)) state.current = value; }
    else if (port === 'inc' || port === 'dec') {
      const direction = port === 'inc' ? 1 : -1;
      if (state.current && state.current.type === 'bits') {
        const width = state.current.width; const current = bitsBigInt(state.current); const max = (1n << BigInt(width)) - 1n;
        let next = current + BigInt(direction);
        if (node.config.overflow === 'saturate') next = next < 0n ? 0n : next > max ? max : next;
        state.current = bitsValue(width, next);
      } else {
        const current = state.current && state.current.type === 'number' ? state.current.value : 0;
        let next = current + direction;
        if (node.config.overflow === 'saturate') next = Math.max(0, Math.min(Number.MAX_SAFE_INTEGER, next));
        else if (next > Number.MAX_SAFE_INTEGER) next = 0; else if (next < 0) next = Number.MAX_SAFE_INTEGER;
        state.current = { type: 'number', value: next };
      }
    }
  } else if (node.type === 'timer') {
    if (port === 'reset') { state.elapsedMs = 0; state.running = false; state.done = false; }
    else if (port === 'pause') state.running = false;
    else if (port === 'start') {
      const preset = readInput(runtime, node.id, 'preset');
      if (preset && preset.type === 'number' && Number.isFinite(preset.value) && preset.value > 0) state.durationMs = preset.value;
      if (state.elapsedMs >= state.durationMs) state.elapsedMs = 0;
      state.done = false; state.running = true;
    }
  }
  staged.set(node.id, state);
}

export function emitResearchPulses(runtime, sources, simulationTime = runtime.simulationTime) {
  const queue = (Array.isArray(sources) ? sources : []).map((source) => ({ ...source, simulationTime }));
  let processed = 0;
  runtime.batchEvaluations = 0;
  while (queue.length) {
    if (processed >= MAX_PULSES_PER_BATCH || queue.length > MAX_PULSES_PER_BATCH - processed
      || runtime.batchEvaluations >= MAX_EVALUATIONS_PER_BATCH) {
      runtime.halted = true;
      runtime.runtimeError = errorValue('execution-budget', '事件批次超过安全预算，已暂停仿真');
      break;
    }
    const currentSources = queue.splice(0);
    const deliveries = [];
    currentSources.forEach((source) => {
      processed += 1;
      runtime.sequence += 1;
      const item = runtime.projection[source.nodeId] || (runtime.projection[source.nodeId] = projectionItem());
      const pulse = { sequence: runtime.sequence, simulationTime };
      item.lastPulse = pulse;
      const byPort = runtime.compiled.outgoingEvents.get(String(source.nodeId));
      (byPort && byPort.get(String(source.portId)) || []).forEach((edge) => deliveries.push({ ...edge, pulse }));
    });
    deliveries.sort((a, b) => a.pulse.sequence - b.pulse.sequence || a.order - b.order);
    const staged = new Map();
    deliveries.forEach((delivery) => { observeProbeEvent(runtime, delivery); applyEventToStage(runtime, delivery, staged); });
    const dirty = new Set();
    staged.forEach((next, nodeId) => {
      const previous = runtime.stateByNodeId.get(nodeId);
      if (JSON.stringify(previous) === JSON.stringify(next)) return;
      runtime.stateByNodeId.set(nodeId, next); dirty.add(nodeId);
      if (runtime.compiled.nodeById.get(nodeId).statePolicy === 'persist') runtime.persistentDirty = true;
    });
    if (dirty.size) recompute(runtime, dirty).forEach((pulse) => queue.push({ ...pulse, simulationTime }));
    if (runtime.batchEvaluations > MAX_EVALUATIONS_PER_BATCH) {
      runtime.halted = true;
      runtime.runtimeError = errorValue('execution-budget', '事件批次超过安全预算，已暂停仿真');
      break;
    }
  }
  runtime.counters.pulseCount += processed;
  runtime.counters.eventBatchCount += 1;
  runtime.result = buildResult(runtime, { processedPulseCount: processed });
  runtime.batchEvaluations = null;
  return runtime.result;
}

export function emitResearchPulse(runtime, nodeId, portId, simulationTime = runtime.simulationTime) {
  return emitResearchPulses(runtime, [{ nodeId: String(nodeId), portId: String(portId) }], simulationTime);
}

export function activateResearchNode(runtime, nodeId) {
  const node = runtime.compiled.nodeById.get(String(nodeId));
  if (!node) return runtime.result;
  if (node.type === 'button') return emitResearchPulse(runtime, node.id, 'fire');
  if (node.type === 'toggle') {
    const state = runtime.stateByNodeId.get(node.id); state.current = !state.current;
    if (node.statePolicy === 'persist') runtime.persistentDirty = true;
    const pulses = recompute(runtime, new Set([node.id]));
    if (pulses.length) emitResearchPulses(runtime, pulses);
  }
  return runtime.result;
}

export function nextResearchBoundary(runtime) {
  let next = Infinity;
  runtime.compiled.stateNodeIds.forEach((nodeId) => {
    const node = runtime.compiled.nodeById.get(nodeId); const state = runtime.stateByNodeId.get(nodeId);
    if (node.type === 'clock') next = Math.min(next, state.nextTick);
    if (node.type === 'timer' && state.running) {
      const precision = Math.max(16, Number(node.config.precisionMs) || 1000);
      const boundary = Math.min(state.durationMs - state.elapsedMs,
        precision - (state.elapsedMs % precision || 0));
      next = Math.min(next, runtime.simulationTime + Math.max(1, boundary));
    }
  });
  return next;
}

function beginTimePhase(runtime, targetTime) {
  const next = nextResearchBoundary(runtime);
  const boundary = Number.isFinite(next) ? Math.min(targetTime, next) : targetTime;
  return {
    boundary,
    delta: Math.max(0, boundary - runtime.simulationTime),
    nodeIds: runtime.compiled.stateNodeIds.filter((nodeId) => {
      const node = runtime.compiled.nodeById.get(nodeId);
      const state = runtime.stateByNodeId.get(nodeId);
      return node.type === 'clock' || node.type === 'timer' && state.running;
    }),
    cursor: 0,
    staged: new Map(),
    dirty: new Set(),
    pulses: [],
    persistentChanged: new Set(),
  };
}

function finishTimePhase(runtime, task) {
  task.phase.staged.forEach((state, nodeId) => {
    runtime.stateByNodeId.set(nodeId, state);
  });
  if (task.phase.persistentChanged.size) runtime.persistentDirty = true;
  runtime.simulationTime = task.phase.boundary;
  if (task.phase.dirty.size) recompute(runtime, task.phase.dirty);
  if (task.phase.pulses.length) emitResearchPulses(runtime, task.phase.pulses, task.phase.boundary);
  task.steps += Math.max(1, task.phase.pulses.length);
  task.phase = null;
}

export function advanceResearchTimeSlice(runtime, targetTime, previousTask = null, options = {}) {
  targetTime = Math.max(runtime.simulationTime, Number(targetTime) || runtime.simulationTime);
  const task = previousTask && previousTask.runtime === runtime && previousTask.targetTime === targetTime
    ? previousTask : { runtime, targetTime, phase: null, steps: 0 };
  const maxSources = Math.max(1, Number(options.maxSources) || 256);
  const timeBudgetMs = Math.max(0.1, Number(options.timeBudgetMs) || 4);
  const measureNow = typeof options.measureNow === 'function' ? options.measureNow : nowMilliseconds;
  const startedAt = measureNow();
  let processed = 0;
  while (runtime.simulationTime < targetTime && !runtime.halted && task.steps < MAX_PULSES_PER_BATCH) {
    if (!task.phase) task.phase = beginTimePhase(runtime, targetTime);
    const phase = task.phase;
    while (phase.cursor < phase.nodeIds.length && processed < maxSources) {
      const nodeId = phase.nodeIds[phase.cursor++];
      const node = runtime.compiled.nodeById.get(nodeId);
      const original = runtime.stateByNodeId.get(nodeId);
      const state = cloneStateRecord(original);
      if (node.type === 'timer' && state.running && phase.delta > 0) {
        state.elapsedMs = Math.min(state.durationMs, state.elapsedMs + phase.delta);
        phase.dirty.add(nodeId);
        if (state.elapsedMs >= state.durationMs && !state.done) {
          state.done = true; state.running = false; phase.pulses.push({ nodeId, portId: 'done' });
          if (node.statePolicy === 'persist') phase.persistentChanged.add(nodeId);
        }
        phase.staged.set(nodeId, state);
      } else if (node.type === 'clock' && state.nextTick <= phase.boundary) {
        const enabled = readInput(runtime, nodeId, 'enabled');
        if (!enabled || enabled.type !== 'boolean' || enabled.value) phase.pulses.push({ nodeId, portId: 'tick' });
        const period = Math.max(16, Number(node.config.periodMs) || 1000);
        do { state.nextTick += period; } while (state.nextTick <= phase.boundary);
        phase.staged.set(nodeId, state);
      }
      processed += 1;
      if (measureNow() - startedAt >= timeBudgetMs) break;
    }
    if (phase.cursor < phase.nodeIds.length) break;
    finishTimePhase(runtime, task);
    if (processed >= maxSources || measureNow() - startedAt >= timeBudgetMs) break;
  }
  const done = runtime.simulationTime >= targetTime || runtime.halted || task.steps >= MAX_PULSES_PER_BATCH;
  runtime.counters.timeSliceCount += 1;
  runtime.result = buildResult(runtime, { timeStepCount: task.steps, timeSourcesProcessed: processed });
  return { done, task: done ? null : task, result: runtime.result, processed };
}

export function advanceResearchTime(runtime, targetTime) {
  let task = null; let slice;
  do {
    slice = advanceResearchTimeSlice(runtime, targetTime, task, {
      maxSources: Number.MAX_SAFE_INTEGER, timeBudgetMs: Number.MAX_SAFE_INTEGER, measureNow: () => 0,
    });
    task = slice.task;
  } while (!slice.done);
  return slice.result;
}

export function refreshResearchWallTime(runtime, timestamp = Date.now()) {
  runtime.wallTime = Number(timestamp) || Date.now();
  const dirty = new Set(Array.from(runtime.compiled.nodeById.values())
    .filter((node) => node.type === 'current-time').map((node) => String(node.id)));
  if (dirty.size) recompute(runtime, dirty);
  return runtime.result;
}

export function snapshotPersistentResearchState(runtime) {
  const result = {};
  runtime.compiled.stateNodeIds.forEach((nodeId) => {
    const node = runtime.compiled.nodeById.get(nodeId);
    if (node.statePolicy !== 'persist') return;
    const state = runtime.stateByNodeId.get(nodeId);
    if (node.type === 'clock') result[nodeId] = { remainingMs: Math.max(0, state.nextTick - runtime.simulationTime) };
    else if (node.type === 'toggle') result[nodeId] = { current: state.current };
    else if (node.type === 'register' || node.type === 'counter') result[nodeId] = { current: copyResearchValue(state.current) };
    else if (node.type === 'edge-detector') result[nodeId] = { previous: state.previous };
    else if (node.type === 'timer') result[nodeId] = {
      durationMs: state.durationMs, elapsedMs: state.elapsedMs, running: state.running, done: state.done,
    };
  });
  runtime.persistentDirty = false;
  return result;
}

export function clearResearchTrace(runtime, nodeId = '') {
  const ids = nodeId ? [String(nodeId)] : Array.from(runtime.traceByNodeId.keys());
  ids.forEach((id) => {
    const record = runtime.traceByNodeId.get(id);
    if (!record) return;
    record.entries = [];
    exposeProbeTrace(runtime, id);
  });
  runtime.result = buildResult(runtime);
  return runtime.result;
}

export function resetResearchComputeRuntime(runtime) {
  runtime.simulationTime = 0; runtime.halted = false; runtime.runtimeError = null;
  runtime.stateByNodeId.clear(); syncStateRecords(runtime.compiled, runtime.stateByNodeId, 0, false);
  runtime.traceByNodeId.clear(); runtime.traceOrder = 0; syncProbeTraces(runtime);
  runtime.portValues.clear(); runtime.projection = {};
  recompute(runtime, null, { initializeEdges: true });
  runtime.persistentDirty = true;
  return runtime.result;
}

export function createResearchComputeRuntime(source = {}, options = {}) {
  const compiled = compileResearchGraph(source, options.registry);
  const runtime = {
    registry: options.registry, compiled, projection: {}, portValues: new Map(), stateByNodeId: new Map(),
    traceByNodeId: new Map(), traceOrder: 0,
    wallTime: Number(options.wallTime) || Date.now(), simulationTime: 0, sequence: 0,
    halted: false, runtimeError: null, persistentDirty: false, result: null, batchEvaluations: null,
    counters: { compileCount: 1, runCount: 1, evaluatedNodeCount: 0, pulseCount: 0, eventBatchCount: 0, timeSliceCount: 0 },
  };
  syncStateRecords(compiled, runtime.stateByNodeId, 0, true);
  syncProbeTraces(runtime);
  recompute(runtime, null, { initializeEdges: true });
  return runtime;
}

export function updateResearchComputeRuntime(runtime, source = {}, options = {}) {
  const startedAt = nowMilliseconds();
  if (options.topology) {
    runtime.compiled = compileResearchGraph(source, runtime.registry);
    syncStateRecords(runtime.compiled, runtime.stateByNodeId, runtime.simulationTime, true);
    syncProbeTraces(runtime);
    runtime.portValues.clear(); runtime.projection = {}; runtime.counters.compileCount += 1;
    recompute(runtime, null, { initializeEdges: true });
  } else {
    (Array.isArray(source.nodes) ? source.nodes : []).forEach((node) => {
      if (node && runtime.compiled.nodeById.has(String(node.id))) runtime.compiled.nodeById.set(String(node.id), node);
    });
    const dirty = new Set(Array.from(options.dirtyNodeIds || [], String));
    if (dirty.size) {
      syncStateRecords(runtime.compiled, runtime.stateByNodeId, runtime.simulationTime, true);
      const pulses = recompute(runtime, dirty);
      if (pulses.length) emitResearchPulses(runtime, pulses);
    }
  }
  runtime.counters.runCount += 1;
  runtime.result = buildResult(runtime, { durationMs: Math.max(0, nowMilliseconds() - startedAt) });
  return runtime.result;
}

export function runResearchOnce(source = {}, options = {}) {
  return createResearchComputeRuntime(source, options).result;
}

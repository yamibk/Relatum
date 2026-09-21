const HISTORY_LIMIT = 50;
const NODE_WIDTH = 176;
const NODE_HEIGHT = 72;

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function cloneState(state) {
  return { nodes: state.nodes.map(clone), edges: state.edges.map(clone) };
}

function sameState(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function id(prefix) {
  if (globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function') {
    return prefix + '-' + globalThis.crypto.randomUUID();
  }
  return prefix + '-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2);
}

function normalizeNode(source, registry) {
  const node = source && typeof source === 'object' ? source : {};
  const type = String(node.type || 'note');
  const defaults = registry && registry.createNode(type, node) || {
    type, label: String(node.label || ''), config: clone(node.config || {}), statePolicy: 'reset',
  };
  const normalized = {
    id: String(node.id || id('node')),
    type: defaults.type,
    label: String(node.label || defaults.label || ''),
    x: Number.isFinite(Number(node.x)) ? Number(node.x) : 0,
    y: Number.isFinite(Number(node.y)) ? Number(node.y) : 0,
    width: Math.max(96, Number(node.width) || NODE_WIDTH),
    height: Math.max(48, Number(node.height) || NODE_HEIGHT),
    config: registry ? registry.normalizeConfig(type, node.config) : clone(node.config || {}),
    statePolicy: defaults.statePolicy === 'persist' ? 'persist' : 'reset',
  };
  if ((normalized.statePolicy === 'persist' || normalized.type === 'subcircuit')
    && node.savedState && typeof node.savedState === 'object') {
    normalized.savedState = clone(node.savedState);
  }
  return normalized;
}

function edgeEndpoints(edge) {
  return edge && edge.kind === 'wire'
    ? [String(edge.from && edge.from.nodeId || ''), String(edge.to && edge.to.nodeId || '')]
    : [String(edge && edge.fromNodeId || ''), String(edge && edge.toNodeId || '')];
}

function normalizeEdge(source, nodeById, registry) {
  const edge = source && typeof source === 'object' ? source : {};
  if (edge.kind === 'wire') {
    const from = { nodeId: String(edge.from && edge.from.nodeId || ''), portId: String(edge.from && edge.from.portId || '') };
    const to = { nodeId: String(edge.to && edge.to.nodeId || ''), portId: String(edge.to && edge.to.portId || '') };
    if (!from.nodeId || !to.nodeId || from.nodeId === to.nodeId
      || !nodeById.has(from.nodeId) || !nodeById.has(to.nodeId)) return null;
    if (registry && !registry.compatiblePorts(nodeById.get(from.nodeId), from.portId, nodeById.get(to.nodeId), to.portId)) return null;
    return { id: String(edge.id || id('edge')), kind: 'wire', from, to };
  }
  const fromNodeId = String(edge.fromNodeId || edge.from || '');
  const toNodeId = String(edge.toNodeId || edge.to || '');
  if (!fromNodeId || !toNodeId || fromNodeId === toNodeId
    || !nodeById.has(fromNodeId) || !nodeById.has(toNodeId)) return null;
  return { id: String(edge.id || id('edge')), kind: 'relation', fromNodeId, toNodeId };
}

export class ResearchModel {
  constructor(initialState = {}, registry = null) {
    this.registry = registry;
    this.listeners = new Set();
    this.nodeById = new Map();
    this.edgeById = new Map();
    this.edgesByNodeId = new Map();
    this.state = { nodes: [], edges: [] };
    this.restore(initialState, false);
    this.history = [this.snapshot()];
    this.historyIndex = 0;
  }

  restore(nextState, notify = true) {
    const nodes = (Array.isArray(nextState && nextState.nodes) ? nextState.nodes : [])
      .map((node) => normalizeNode(node, this.registry));
    const nodeById = new Map(nodes.map((node) => [node.id, node]));
    const seen = new Set();
    const occupied = new Set();
    const edges = (Array.isArray(nextState && nextState.edges) ? nextState.edges : [])
      .map((edge) => normalizeEdge(edge, nodeById, this.registry))
      .filter((edge) => {
        if (!edge || seen.has(edge.id)) return false;
        if (edge.kind === 'wire') {
          const port = this.registry && this.registry.port(nodeById.get(edge.to.nodeId), edge.to.portId, 'input');
          if (port && port.channel === 'value') {
            const key = edge.to.nodeId + '\n' + edge.to.portId;
            if (occupied.has(key)) return false;
            occupied.add(key);
          }
        }
        seen.add(edge.id);
        return true;
      });
    this.state = { nodes, edges };
    this.reindex();
    if (notify) this.emit({ kind: 'restore', topology: true });
  }

  reindex() {
    this.nodeById.clear();
    this.edgeById.clear();
    this.edgesByNodeId.clear();
    this.state.nodes.forEach((node) => {
      this.nodeById.set(node.id, node);
      this.edgesByNodeId.set(node.id, new Set());
    });
    this.state.edges.forEach((edge) => {
      this.edgeById.set(edge.id, edge);
      edgeEndpoints(edge).forEach((nodeId) => {
        if (this.edgesByNodeId.has(nodeId)) this.edgesByNodeId.get(nodeId).add(edge.id);
      });
    });
  }

  snapshot() { return cloneState(this.state); }
  nodes() { return this.state.nodes.slice(); }
  edges() { return this.state.edges.slice(); }
  isEmpty() { return !this.state.nodes.length && !this.state.edges.length; }
  node(nodeId) { return this.nodeById.get(String(nodeId)) || null; }
  edge(edgeId) { return this.edgeById.get(String(edgeId)) || null; }

  incidentEdgeIds(nodeIds) {
    const result = new Set();
    nodeIds.forEach((nodeId) => {
      const ids = this.edgesByNodeId.get(String(nodeId));
      if (ids) ids.forEach((edgeId) => result.add(edgeId));
    });
    return result;
  }

  subscribe(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  emit(change) { this.listeners.forEach((listener) => listener(change || {})); }
  capture() { return this.snapshot(); }

  commitFrom(before, change = {}) {
    const after = this.snapshot();
    if (sameState(before, after)) return false;
    this.history.splice(this.historyIndex + 1);
    this.history.push(after);
    if (this.history.length > HISTORY_LIMIT) this.history.shift();
    this.historyIndex = this.history.length - 1;
    if (!change.alreadyEmitted) this.emit(change);
    return true;
  }

  mutate(mutator, change = {}) {
    const before = this.capture();
    mutator(this.state);
    this.reindex();
    const committed = this.commitFrom(before, { ...change, alreadyEmitted: true });
    if (committed) this.emit(change);
    return committed;
  }

  createNode(source = {}) {
    let created = null;
    this.mutate((state) => {
      created = normalizeNode({ ...source, id: source.id || id('node') }, this.registry);
      while (this.nodeById.has(created.id)) created.id = id('node');
      state.nodes.push(created);
    }, { kind: 'node-create', topology: true, nodeIds: [] });
    return created;
  }

  updateNode(nodeId, patch, options = {}) {
    const node = this.node(nodeId);
    if (!node) return false;
    const nextType = Object.prototype.hasOwnProperty.call(patch, 'type') ? String(patch.type || '') : node.type;
    if (this.registry && !this.registry.definition(nextType)) return false;
    const topology = nextType !== node.type || Object.prototype.hasOwnProperty.call(patch, 'config');
    const apply = () => {
      if (Number.isFinite(Number(patch.x))) node.x = Number(patch.x);
      if (Number.isFinite(Number(patch.y))) node.y = Number(patch.y);
      if (Object.prototype.hasOwnProperty.call(patch, 'width')) node.width = Math.max(96, Number(patch.width) || node.width);
      if (Object.prototype.hasOwnProperty.call(patch, 'height')) node.height = Math.max(48, Number(patch.height) || node.height);
      if (Object.prototype.hasOwnProperty.call(patch, 'label')) node.label = String(patch.label || '');
      if (Object.prototype.hasOwnProperty.call(patch, 'type')) node.type = nextType;
      if (Object.prototype.hasOwnProperty.call(patch, 'config')) {
        node.config = this.registry ? this.registry.normalizeConfig(nextType, patch.config) : clone(patch.config || {});
      }
      if (Object.prototype.hasOwnProperty.call(patch, 'statePolicy')) {
        const definition = this.registry && this.registry.definition(nextType);
        node.statePolicy = definition && definition.stateful && patch.statePolicy === 'persist' ? 'persist' : 'reset';
        if (node.statePolicy !== 'persist') delete node.savedState;
      }
      if (Object.prototype.hasOwnProperty.call(patch, 'savedState')) {
        if ((node.statePolicy === 'persist' || nextType === 'subcircuit')
          && patch.savedState && typeof patch.savedState === 'object') node.savedState = clone(patch.savedState);
        else delete node.savedState;
      }
    };
    const change = { kind: 'node-update', nodeIds: [node.id], live: !!options.live, topology };
    if (options.live) { apply(); this.emit(change); return true; }
    return this.mutate(apply, change);
  }

  moveNodes(positions, options = {}) {
    const changed = [];
    Object.entries(positions || {}).forEach(([nodeId, point]) => {
      const node = this.node(nodeId);
      if (!node || !point) return;
      const x = Number(point.x); const y = Number(point.y);
      if (!Number.isFinite(x) || !Number.isFinite(y) || (node.x === x && node.y === y)) return;
      node.x = x; node.y = y; changed.push(node.id);
    });
    if (changed.length) this.emit({ kind: 'node-move', nodeIds: changed, live: !!options.live });
    return changed;
  }

  valueDescriptor(nodeId, portId, seen = new Set()) {
    const key = String(nodeId) + '\n' + String(portId);
    if (seen.has(key)) return null;
    seen.add(key);
    const node = this.node(nodeId);
    if (!node) return null;
    const typed = (value) => value && typeof value === 'object' && value.type
      ? { type: value.type, ...(value.type === 'bits' ? { width: Number(value.width) } : {}) } : null;
    const incoming = (inputPortId) => {
      const edge = this.state.edges.find((candidate) => candidate.kind === 'wire'
        && candidate.to.nodeId === node.id && candidate.to.portId === inputPortId);
      return edge ? this.valueDescriptor(edge.from.nodeId, edge.from.portId, seen) : null;
    };
    if (node.type === 'constant' && portId === 'out') return typed(node.config.value);
    if (node.type === 'subcircuit') {
      const port = this.registry && this.registry.port(node, portId, 'output');
      if (!port || port.channel !== 'value' || !port.types || port.types.length !== 1 || port.types[0] === 'any') return null;
      return { type: port.types[0], ...(port.types[0] === 'bits' && port.bitsWidths.length === 1
        ? { width: Number(port.bitsWidths[0]) } : {}) };
    }
    if (node.type === 'toggle' && portId === 'out') return { type: 'boolean' };
    if (node.type === 'current-time' && portId === 'out') return { type: 'time' };
    if (node.type === 'timer') return portId === 'time' ? { type: 'number' }
      : portId === 'running' ? { type: 'boolean' } : null;
    if ((node.type === 'register' || node.type === 'counter') && portId === 'out') return typed(node.config.initial);
    if (node.type === 'compare' && portId === 'out') return { type: 'boolean' };
    if (node.type === 'convert' && portId === 'out') return {
      type: node.config.toType, ...(node.config.toType === 'bits' ? { width: Number(node.config.width) } : {}),
    };
    if ((node.type === 'math' || node.type === 'logic') && portId === 'out') return incoming('a');
    if (node.type === 'select' && portId === 'out') return incoming('whenTrue') || incoming('whenFalse');
    if (node.type === 'bits' && portId === 'out') {
      if (node.config.operation === 'slice' || node.config.operation === 'resize') return { type: 'bits', width: Number(node.config.width) };
      const left = incoming('a'); const right = incoming('b');
      if (node.config.operation === 'concat' && left && right && left.type === 'bits' && right.type === 'bits') {
        return { type: 'bits', width: left.width + right.width };
      }
      return left;
    }
    return null;
  }

  canCreateWire(fromNodeId, fromPortId, toNodeId, toPortId, options = {}) {
    const fromNode = this.node(fromNodeId); const toNode = this.node(toNodeId);
    const ignoreEdgeId = String(options.ignoreEdgeId || '');
    if (!fromNode || !toNode || fromNode.id === toNode.id || !this.registry
      || !this.registry.compatiblePorts(fromNode, fromPortId, toNode, toPortId)) return false;
    const port = this.registry.port(toNode, toPortId, 'input');
    if (port && port.channel === 'value') {
      if (this.state.edges.some((edge) => edge.kind === 'wire'
        && edge.id !== ignoreEdgeId
        && edge.to.nodeId === toNode.id && edge.to.portId === String(toPortId))) return false;
      const descriptor = this.valueDescriptor(fromNode.id, fromPortId);
      if (descriptor && descriptor.type === 'bits' && port.bitsWidths.length
        && !port.bitsWidths.includes(descriptor.width)) return false;
      if (descriptor && port.matchGroup) {
        const peerIds = this.registry.portsFor(toNode).filter((candidate) => candidate.direction === 'input'
          && candidate.matchGroup === port.matchGroup && candidate.id !== port.id).map((candidate) => candidate.id);
        const peerEdge = this.state.edges.find((edge) => edge.kind === 'wire' && edge.id !== ignoreEdgeId
          && edge.to.nodeId === toNode.id
          && peerIds.includes(edge.to.portId));
        const peer = peerEdge && this.valueDescriptor(peerEdge.from.nodeId, peerEdge.from.portId);
        if (peer && (peer.type !== descriptor.type
          || peer.type === 'bits' && peer.width !== descriptor.width)) return false;
      }
      if (descriptor && ((toNode.type === 'register' && toPortId === 'data')
        || (toNode.type === 'counter' && toPortId === 'loadValue'))) {
        const expected = toNode.config && toNode.config.initial;
        if (expected && (expected.type !== descriptor.type
          || expected.type === 'bits' && Number(expected.width) !== descriptor.width)) return false;
      }
    }
    return true;
  }

  reconnectWire(edgeId, fromNodeId, fromPortId, toNodeId, toPortId) {
    const existing = this.edge(edgeId);
    if (!existing || existing.kind !== 'wire') return null;
    const from = { nodeId: String(fromNodeId), portId: String(fromPortId) };
    const to = { nodeId: String(toNodeId), portId: String(toPortId) };
    if (existing.from.nodeId === from.nodeId && existing.from.portId === from.portId
      && existing.to.nodeId === to.nodeId && existing.to.portId === to.portId) return existing;
    if (!this.canCreateWire(from.nodeId, from.portId, to.nodeId, to.portId, { ignoreEdgeId: existing.id })) return null;
    const normalized = normalizeEdge({ id: existing.id, kind: 'wire', from, to }, this.nodeById, this.registry);
    if (!normalized) return null;
    const duplicate = this.state.edges.some((edge) => edge.id !== existing.id
      && JSON.stringify({ ...edge, id: '' }) === JSON.stringify({ ...normalized, id: '' }));
    if (duplicate) return null;
    const changed = this.mutate((state) => {
      const index = state.edges.findIndex((edge) => edge.id === existing.id);
      if (index >= 0) state.edges[index] = normalized;
    }, { kind: 'edge-reconnect', topology: true, edgeIds: [existing.id] });
    return changed ? this.edge(existing.id) : null;
  }

  createEdge(from, to, source = {}) {
    const kind = source.kind === 'wire' ? 'wire' : 'relation';
    const candidate = kind === 'wire' ? {
      ...source, kind, from: { nodeId: String(from), portId: String(source.fromPortId || source.fromPort || '') },
      to: { nodeId: String(to), portId: String(source.toPortId || source.toPort || '') },
    } : { ...source, kind, fromNodeId: String(from), toNodeId: String(to) };
    if (kind === 'wire' && !this.canCreateWire(from, candidate.from.portId, to, candidate.to.portId)) return null;
    const normalized = normalizeEdge(candidate, this.nodeById, this.registry);
    if (!normalized) return null;
    const duplicate = this.state.edges.find((edge) => JSON.stringify({ ...edge, id: '' }) === JSON.stringify({ ...normalized, id: '' }));
    if (duplicate) return duplicate;
    let created = null;
    this.mutate((state) => {
      created = { ...normalized, id: source.id || id('edge') };
      while (this.edgeById.has(created.id)) created.id = id('edge');
      state.edges.push(created);
    }, { kind: 'edge-create', topology: true, edgeIds: [] });
    return created;
  }

  createLinkedNode(from, nodeSource = {}) {
    const created = this.createNode(nodeSource);
    if (created) this.createEdge(from, created.id, { kind: 'relation' });
    return created;
  }

  remove(nodeIds, edgeIds) {
    const nodes = new Set(Array.from(nodeIds || [], String));
    const edges = new Set(Array.from(edgeIds || [], String));
    if (!nodes.size && !edges.size) return false;
    return this.mutate((state) => {
      state.nodes = state.nodes.filter((node) => !nodes.has(node.id));
      state.edges = state.edges.filter((edge) => {
        const [from, to] = edgeEndpoints(edge);
        return !edges.has(edge.id) && !nodes.has(from) && !nodes.has(to);
      });
    }, { kind: 'remove', topology: true, nodeIds: [...nodes], edgeIds: [...edges] });
  }

  replaceState(nextState, change = {}) {
    const before = this.capture();
    this.restore(nextState, false);
    const committed = this.commitFrom(before, { kind: 'replace-state', topology: true, ...change, alreadyEmitted: true });
    if (committed) this.emit({ kind: 'replace-state', topology: true, ...change });
    return committed;
  }

  undo() {
    if (this.historyIndex <= 0) return false;
    this.historyIndex -= 1; this.restore(this.history[this.historyIndex], true); return true;
  }

  redo() {
    if (this.historyIndex >= this.history.length - 1) return false;
    this.historyIndex += 1; this.restore(this.history[this.historyIndex], true); return true;
  }
}

export function createResearchModel(initialState, registry) {
  return new ResearchModel(initialState, registry);
}

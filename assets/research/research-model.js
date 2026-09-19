const HISTORY_LIMIT = 50;
const NODE_WIDTH = 168;
const NODE_HEIGHT = 64;

function cloneState(state) {
  return {
    nodes: state.nodes.map((node) => ({ ...node })),
    edges: state.edges.map((edge) => ({ ...edge })),
  };
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

function normalizeNode(source) {
  const node = source && typeof source === 'object' ? source : {};
  return {
    id: String(node.id || id('node')),
    x: Number.isFinite(Number(node.x)) ? Number(node.x) : 0,
    y: Number.isFinite(Number(node.y)) ? Number(node.y) : 0,
    width: Math.max(96, Number(node.width) || NODE_WIDTH),
    height: Math.max(48, Number(node.height) || NODE_HEIGHT),
    text: String(node.text || ''),
  };
}

function normalizeEdge(source, nodeIds) {
  const edge = source && typeof source === 'object' ? source : {};
  const from = String(edge.from || '');
  const to = String(edge.to || '');
  if (!from || !to || from === to || !nodeIds.has(from) || !nodeIds.has(to)) return null;
  return {
    id: String(edge.id || id('edge')),
    from,
    to,
    role: edge.role === 'data' ? 'data' : 'visual',
    fromPort: String(edge.fromPort || 'out'),
    toPort: String(edge.toPort || 'in'),
  };
}

export class ResearchModel {
  constructor(initialState = {}) {
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
    const rawNodes = Array.isArray(nextState.nodes) ? nextState.nodes : [];
    const nodes = rawNodes.map(normalizeNode);
    const nodeIds = new Set(nodes.map((node) => node.id));
    const seenEdges = new Set();
    const edges = (Array.isArray(nextState.edges) ? nextState.edges : [])
      .map((edge) => normalizeEdge(edge, nodeIds))
      .filter((edge) => edge && !seenEdges.has(edge.id) && seenEdges.add(edge.id));
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
      if (this.edgesByNodeId.has(edge.from)) this.edgesByNodeId.get(edge.from).add(edge.id);
      if (this.edgesByNodeId.has(edge.to)) this.edgesByNodeId.get(edge.to).add(edge.id);
    });
  }

  snapshot() {
    return cloneState(this.state);
  }

  nodes() {
    return this.state.nodes.slice();
  }

  edges() {
    return this.state.edges.slice();
  }

  node(nodeId) {
    return this.nodeById.get(String(nodeId)) || null;
  }

  edge(edgeId) {
    return this.edgeById.get(String(edgeId)) || null;
  }

  incidentEdgeIds(nodeIds) {
    const result = new Set();
    nodeIds.forEach((nodeId) => {
      const ids = this.edgesByNodeId.get(String(nodeId));
      if (ids) ids.forEach((edgeId) => result.add(edgeId));
    });
    return result;
  }

  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(change) {
    this.listeners.forEach((listener) => listener(change || {}));
  }

  capture() {
    return this.snapshot();
  }

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
      created = normalizeNode({ ...source, id: source.id || id('node') });
      while (this.nodeById.has(created.id)) created.id = id('node');
      state.nodes.push(created);
    }, { kind: 'node-create', topology: true, nodeIds: [] });
    return created;
  }

  updateNode(nodeId, patch, options = {}) {
    const node = this.node(nodeId);
    if (!node) return false;
    const apply = () => {
      if (Object.prototype.hasOwnProperty.call(patch, 'x') && Number.isFinite(Number(patch.x))) node.x = Number(patch.x);
      if (Object.prototype.hasOwnProperty.call(patch, 'y') && Number.isFinite(Number(patch.y))) node.y = Number(patch.y);
      if (Object.prototype.hasOwnProperty.call(patch, 'width')) node.width = Math.max(96, Number(patch.width) || node.width);
      if (Object.prototype.hasOwnProperty.call(patch, 'height')) node.height = Math.max(48, Number(patch.height) || node.height);
      if (Object.prototype.hasOwnProperty.call(patch, 'text')) node.text = String(patch.text || '');
    };
    const change = { kind: 'node-update', nodeIds: [node.id], live: !!options.live };
    if (options.live) {
      apply();
      this.emit(change);
      return true;
    }
    return this.mutate(apply, change);
  }

  moveNodes(positions, options = {}) {
    const changed = [];
    Object.entries(positions || {}).forEach(([nodeId, point]) => {
      const node = this.node(nodeId);
      if (!node || !point) return;
      const x = Number(point.x);
      const y = Number(point.y);
      if (!Number.isFinite(x) || !Number.isFinite(y) || (node.x === x && node.y === y)) return;
      node.x = x;
      node.y = y;
      changed.push(node.id);
    });
    if (changed.length) this.emit({ kind: 'node-move', nodeIds: changed, live: !!options.live });
    return changed;
  }

  createEdge(from, to, source = {}) {
    from = String(from || '');
    to = String(to || '');
    if (!this.nodeById.has(from) || !this.nodeById.has(to) || from === to) return null;
    const duplicate = this.state.edges.find((edge) => edge.from === from && edge.to === to);
    if (duplicate) return duplicate;
    let created = null;
    this.mutate((state) => {
      created = normalizeEdge({ ...source, id: source.id || id('edge'), from, to }, this.nodeById);
      while (created && this.edgeById.has(created.id)) created.id = id('edge');
      if (created) state.edges.push(created);
    }, { kind: 'edge-create', topology: true, edgeIds: [] });
    return created;
  }

  createLinkedNode(from, nodeSource = {}, edgeSource = {}) {
    from = String(from || '');
    if (!this.nodeById.has(from)) return null;
    let created = null;
    this.mutate((state) => {
      created = normalizeNode({ ...nodeSource, id: nodeSource.id || id('node') });
      while (this.nodeById.has(created.id)) created.id = id('node');
      state.nodes.push(created);
      const nodeIds = new Set(this.nodeById.keys());
      nodeIds.add(created.id);
      const edge = normalizeEdge({
        ...edgeSource,
        id: edgeSource.id || id('edge'),
        from,
        to: created.id,
      }, nodeIds);
      if (edge) state.edges.push(edge);
    }, { kind: 'linked-node-create', topology: true, nodeIds: [], edgeIds: [] });
    return created;
  }

  remove(nodeIds, edgeIds) {
    const nodes = new Set(Array.from(nodeIds || [], String));
    const edges = new Set(Array.from(edgeIds || [], String));
    if (!nodes.size && !edges.size) return false;
    return this.mutate((state) => {
      state.nodes = state.nodes.filter((node) => !nodes.has(node.id));
      state.edges = state.edges.filter((edge) => !edges.has(edge.id)
        && !nodes.has(edge.from) && !nodes.has(edge.to));
    }, { kind: 'remove', topology: true, nodeIds: [...nodes], edgeIds: [...edges] });
  }

  undo() {
    if (this.historyIndex <= 0) return false;
    this.historyIndex -= 1;
    this.restore(this.history[this.historyIndex], true);
    return true;
  }

  redo() {
    if (this.historyIndex >= this.history.length - 1) return false;
    this.historyIndex += 1;
    this.restore(this.history[this.historyIndex], true);
    return true;
  }
}

export function createResearchModel(initialState) {
  return new ResearchModel(initialState);
}

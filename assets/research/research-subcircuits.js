const VALUE_TYPES = new Set(['number', 'boolean', 'string', 'time', 'bits']);

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function text(value, fallback = '') {
  return String(value == null ? fallback : value);
}

function positiveInteger(value, fallback = 1) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}

export function normalizeSubcircuitPort(source = {}, fallbackId = 'port') {
  const direction = source.direction === 'output' ? 'output' : 'input';
  const channel = source.channel === 'event' ? 'event' : 'value';
  const valueType = channel === 'event' ? 'pulse'
    : VALUE_TYPES.has(text(source.valueType)) ? text(source.valueType) : 'number';
  const result = {
    id: text(source.id, fallbackId),
    name: text(source.name, fallbackId),
    direction,
    channel,
    valueType,
    nodeId: text(source.nodeId),
    portId: text(source.portId),
  };
  if (valueType === 'bits') result.bitsWidth = Math.min(64, Math.max(1, positiveInteger(source.bitsWidth, 1)));
  return result;
}

function normalizeRevision(source = {}, fallbackRevision = 1) {
  const revision = positiveInteger(source.revision, fallbackRevision);
  const portIds = new Set();
  const ports = [];
  (Array.isArray(source.ports) ? source.ports : []).forEach((port, index) => {
    const normalized = normalizeSubcircuitPort(port, `port-${index + 1}`);
    if (!normalized.id || !normalized.nodeId || !normalized.portId || portIds.has(normalized.id)) return;
    portIds.add(normalized.id); ports.push(normalized);
  });
  return {
    revision,
    ports,
    nodes: (Array.isArray(source.nodes) ? source.nodes : []).map(clone),
    edges: (Array.isArray(source.edges) ? source.edges : []).map(clone),
  };
}

function normalizeDefinition(source = {}, index = 0) {
  const revisions = [];
  const revisionNumbers = new Set();
  (Array.isArray(source.revisions) ? source.revisions : []).forEach((revision, revisionIndex) => {
    const normalized = normalizeRevision(revision, revisionIndex + 1);
    if (revisionNumbers.has(normalized.revision)) return;
    revisionNumbers.add(normalized.revision); revisions.push(normalized);
  });
  revisions.sort((left, right) => left.revision - right.revision);
  const latest = revisions.length ? revisions[revisions.length - 1].revision : 0;
  const requestedLatest = positiveInteger(source.latestRevision, latest || 1);
  return {
    id: text(source.id, `subcircuit-${index + 1}`),
    name: text(source.name, `子电路 ${index + 1}`),
    latestRevision: revisionNumbers.has(requestedLatest) ? requestedLatest : latest,
    revisions,
  };
}

export class ResearchSubcircuitCatalog {
  constructor(source = []) {
    this.items = [];
    this.byId = new Map();
    (Array.isArray(source) ? source : []).forEach((item, index) => {
      const normalized = normalizeDefinition(item, index);
      if (!normalized.id || this.byId.has(normalized.id) || !normalized.revisions.length) return;
      this.items.push(normalized); this.byId.set(normalized.id, normalized);
    });
  }

  snapshot() { return this.items.map(clone); }
  definitions() { return this.items.slice(); }
  definition(id) { return this.byId.get(text(id)) || null; }

  revision(id, revision = 0) {
    const definition = this.definition(id);
    if (!definition) return null;
    const number = positiveInteger(revision, definition.latestRevision);
    return definition.revisions.find((item) => item.revision === number) || null;
  }

  portsForNode(node) {
    if (!node || node.type !== 'subcircuit') return [];
    const revision = this.revision(node.config && node.config.definitionId, node.config && node.config.revision);
    return revision ? revision.ports.map((port) => ({
      id: port.id,
      label: port.name,
      direction: port.direction,
      channel: port.channel,
      types: port.channel === 'event' ? ['pulse'] : [port.valueType],
      required: false,
      multiple: port.channel === 'event' && port.direction === 'input',
      bitsWidths: port.valueType === 'bits' ? [port.bitsWidth] : [],
      matchGroup: '',
    })) : [];
  }

  addDefinition(name, revisionSource) {
    const id = globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function'
      ? 'subcircuit-' + globalThis.crypto.randomUUID()
      : 'subcircuit-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2);
    const revision = normalizeRevision({ ...revisionSource, revision: 1 }, 1);
    const definition = { id, name: text(name, '新子电路'), latestRevision: 1, revisions: [revision] };
    this.items.push(definition); this.byId.set(id, definition);
    return clone(definition);
  }

  addRevision(definitionId, revisionSource) {
    const definition = this.definition(definitionId);
    if (!definition) return null;
    const number = Math.max(0, ...definition.revisions.map((item) => item.revision)) + 1;
    const revision = normalizeRevision({ ...revisionSource, revision: number }, number);
    definition.revisions.push(revision); definition.latestRevision = number;
    return clone(revision);
  }

  removeRevision(definitionId, revisionNumber, references = new Set()) {
    const definition = this.definition(definitionId);
    const key = text(definitionId) + '@' + positiveInteger(revisionNumber, 0);
    if (!definition || references.has(key)) return false;
    const index = definition.revisions.findIndex((item) => item.revision === Number(revisionNumber));
    if (index < 0) return false;
    definition.revisions.splice(index, 1);
    if (!definition.revisions.length) {
      this.byId.delete(definition.id);
      this.items = this.items.filter((item) => item !== definition);
    } else {
      definition.latestRevision = definition.revisions[definition.revisions.length - 1].revision;
    }
    return true;
  }
}

export function createResearchSubcircuitCatalog(source) {
  return new ResearchSubcircuitCatalog(source);
}

export function subcircuitReferenceKey(node) {
  if (!node || node.type !== 'subcircuit') return '';
  return text(node.config && node.config.definitionId) + '@' + positiveInteger(node.config && node.config.revision, 0);
}

export function collectSubcircuitReferences(pages = [], catalog = null) {
  const result = new Set();
  const visitNodes = (nodes) => (Array.isArray(nodes) ? nodes : []).forEach((node) => {
    const key = subcircuitReferenceKey(node);
    if (key) result.add(key);
  });
  (Array.isArray(pages) ? pages : []).forEach((page) => visitNodes(page && page.nodes));
  if (catalog) catalog.definitions().forEach((definition) => definition.revisions.forEach((revision) => visitNodes(revision.nodes)));
  return result;
}

export function validateSubcircuitDependencies(catalog, maxDepth = 32) {
  const errors = [];
  const color = new Map();
  const visit = (definitionId, revisionNumber, stack = []) => {
    const key = text(definitionId) + '@' + positiveInteger(revisionNumber, 0);
    const revision = catalog && catalog.revision(definitionId, revisionNumber);
    if (!revision) { errors.push({ code: 'missing-subcircuit-revision', key, stack: stack.slice() }); return; }
    if (stack.length >= maxDepth) { errors.push({ code: 'subcircuit-depth', key, stack: stack.concat(key) }); return; }
    if (color.get(key) === 1) { errors.push({ code: 'subcircuit-cycle', key, stack: stack.concat(key) }); return; }
    if (color.get(key) === 2) return;
    color.set(key, 1);
    revision.nodes.filter((node) => node && node.type === 'subcircuit').forEach((node) => {
      visit(node.config && node.config.definitionId, node.config && node.config.revision, stack.concat(key));
    });
    color.set(key, 2);
  };
  if (catalog) catalog.definitions().forEach((definition) => definition.revisions.forEach((revision) => {
    visit(definition.id, revision.revision, []);
  }));
  return errors;
}

export function portDescriptor(port) {
  if (!port) return null;
  if (port.channel === 'event') return { type: 'pulse' };
  const type = Array.isArray(port.types) && port.types.length === 1 && port.types[0] !== 'any' ? port.types[0] : '';
  if (!type) return null;
  return { type, ...(type === 'bits' && port.bitsWidths && port.bitsWidths.length === 1
    ? { width: Number(port.bitsWidths[0]) } : {}) };
}

function flatIdentifier(path) {
  return '@subcircuit/' + path.map((segment) => {
    const value = text(segment);
    return value.length + ':' + value;
  }).join('/');
}

function stateChild(tree, kind, id) {
  const group = tree && tree[kind] && typeof tree[kind] === 'object' ? tree[kind] : null;
  const value = group && group[id];
  return value && typeof value === 'object' ? value : null;
}

export function expandResearchGraph(source = {}, registry, options = {}) {
  const catalog = registry && registry.subcircuitCatalog ? registry.subcircuitCatalog() : null;
  const maxNodes = Math.max(1, Number(options.maxNodes) || 100000);
  const maxEdges = Math.max(1, Number(options.maxEdges) || 200000);
  const maxDepth = Math.max(1, Number(options.maxDepth) || 32);
  const nodes = [];
  const edges = [];
  const errors = [];
  const publicInstances = new Map();
  const endpointAliases = new Map();
  const stateLocations = new Map();
  let overflowed = false;

  const fail = (code, message, extra = {}) => {
    errors.push({ type: 'error', code, message, ...extra });
  };

  function addNode(node) {
    if (nodes.length >= maxNodes) {
      if (!overflowed) fail('subcircuit-expansion-budget', '子电路展开后的节点数量超过安全上限');
      overflowed = true; return false;
    }
    nodes.push(node); return true;
  }

  function addEdge(edge) {
    if (edges.length >= maxEdges) {
      if (!overflowed) fail('subcircuit-expansion-budget', '子电路展开后的连线数量超过安全上限');
      overflowed = true; return false;
    }
    edges.push(edge); return true;
  }

  function expandGraph(graph, context = {}) {
    const rawNodes = Array.isArray(graph && graph.nodes) ? graph.nodes : [];
    const rawEdges = Array.isArray(graph && graph.edges) ? graph.edges : [];
    const entries = new Map();
    const leafIds = new Set();
    const path = Array.isArray(context.path) ? context.path : [];
    const stack = Array.isArray(context.stack) ? context.stack : [];
    const topInstanceId = text(context.topInstanceId);
    const stateSegments = Array.isArray(context.stateSegments) ? context.stateSegments : [];
    const savedTree = context.savedTree && typeof context.savedTree === 'object' ? context.savedTree : null;

    rawNodes.forEach((rawNode) => {
      if (!rawNode || !rawNode.id || overflowed) return;
      const node = clone(rawNode);
      if (node.type !== 'subcircuit') {
        const flatId = path.length ? flatIdentifier(path.concat(node.id)) : text(node.id);
        node.id = flatId;
        if (path.length) {
          const saved = stateChild(savedTree, 'nodes', rawNode.id);
          if (rawNode.statePolicy === 'persist' && saved) node.savedState = clone(saved);
          else delete node.savedState;
        }
        if (!addNode(node)) return;
        entries.set(text(rawNode.id), { kind: 'leaf', node, leafIds: new Set([flatId]) });
        leafIds.add(flatId);
        if (topInstanceId) stateLocations.set(flatId, {
          topNodeId: topInstanceId,
          segments: stateSegments.concat(text(rawNode.id)),
        });
        return;
      }
      const definitionId = text(node.config && node.config.definitionId);
      const revisionNumber = positiveInteger(node.config && node.config.revision, 0);
      const key = definitionId + '@' + revisionNumber;
      const revision = catalog && catalog.revision(definitionId, revisionNumber);
      if (!revision) {
        fail('missing-subcircuit-revision', '子电路实例引用了不存在的修订', { nodeId: text(rawNode.id), definitionId, revision: revisionNumber });
        entries.set(text(rawNode.id), { kind: 'invalid', leafIds: new Set() }); return;
      }
      if (stack.includes(key)) {
        fail('subcircuit-cycle', '子电路修订形成递归依赖', { nodeId: text(rawNode.id), definitionId, revision: revisionNumber });
        entries.set(text(rawNode.id), { kind: 'invalid', leafIds: new Set() }); return;
      }
      if (stack.length >= maxDepth) {
        fail('subcircuit-depth', '子电路嵌套深度超过安全上限', { nodeId: text(rawNode.id), definitionId, revision: revisionNumber });
        entries.set(text(rawNode.id), { kind: 'invalid', leafIds: new Set() }); return;
      }
      const childTop = topInstanceId || text(rawNode.id);
      const childStateSegments = topInstanceId ? stateSegments.concat(text(rawNode.id)) : [];
      const childSaved = topInstanceId ? stateChild(savedTree, 'instances', rawNode.id)
        : rawNode.savedState && typeof rawNode.savedState === 'object' ? rawNode.savedState : null;
      const child = expandGraph(revision, {
        path: path.concat(text(rawNode.id), 'r' + revisionNumber), stack: stack.concat(key), topInstanceId: childTop,
        stateSegments: childStateSegments, savedTree: childSaved,
      });
      const entry = { kind: 'instance', node: rawNode, revision, child, leafIds: child.leafIds };
      entries.set(text(rawNode.id), entry);
      child.leafIds.forEach((id) => leafIds.add(id));
      if (!topInstanceId && !path.length) {
        const ports = new Map();
        revision.ports.forEach((port) => {
          const endpoint = child.resolve(port.nodeId, port.portId, port.direction);
          if (endpoint) {
            ports.set(port.id, { ...endpoint, direction: port.direction, channel: port.channel });
            if (port.direction === 'output') endpointAliases.set(endpoint.nodeId + '\n' + endpoint.portId, {
              nodeId: text(rawNode.id), portId: port.id, label: text(rawNode.label, rawNode.id),
            });
          }
        });
        publicInstances.set(text(rawNode.id), { node: rawNode, ports, leafIds: new Set(child.leafIds) });
      }
    });

    const resolve = (nodeId, portId, direction) => {
      const entry = entries.get(text(nodeId));
      if (!entry || entry.kind === 'invalid') return null;
      if (entry.kind === 'leaf') return { nodeId: entry.node.id, portId: text(portId) };
      const port = entry.revision.ports.find((candidate) => candidate.id === text(portId)
        && candidate.direction === direction);
      return port ? entry.child.resolve(port.nodeId, port.portId, direction) : null;
    };

    rawEdges.forEach((rawEdge, edgeIndex) => {
      if (!rawEdge || overflowed) return;
      if (rawEdge.kind !== 'wire') {
        const from = entries.get(text(rawEdge.fromNodeId));
        const to = entries.get(text(rawEdge.toNodeId));
        const fromId = from && from.kind === 'leaf' ? from.node.id : '';
        const toId = to && to.kind === 'leaf' ? to.node.id : '';
        if (fromId && toId) addEdge({ id: path.length ? flatIdentifier(path.concat(rawEdge.id || `relation-${edgeIndex}`)) : text(rawEdge.id), kind: 'relation', fromNodeId: fromId, toNodeId: toId });
        return;
      }
      const from = resolve(rawEdge.from && rawEdge.from.nodeId, rawEdge.from && rawEdge.from.portId, 'output');
      const to = resolve(rawEdge.to && rawEdge.to.nodeId, rawEdge.to && rawEdge.to.portId, 'input');
      if (!from || !to) {
        fail('invalid-subcircuit-binding', '子电路导线无法解析到内部端点', { edgeId: text(rawEdge.id) }); return;
      }
      addEdge({
        id: path.length ? flatIdentifier(path.concat(rawEdge.id || `edge-${edgeIndex}`)) : text(rawEdge.id),
        kind: 'wire', from, to,
      });
    });
    return { entries, leafIds, resolve };
  }

  expandGraph(source, { path: [], stack: [], topInstanceId: '', stateSegments: [], savedTree: null });
  return { nodes, edges, errors, publicInstances, endpointAliases, stateLocations };
}

function generatedId(prefix) {
  if (globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function') return prefix + '-' + globalThis.crypto.randomUUID();
  return prefix + '-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2);
}

function edgeNodeIds(edge) {
  return edge && edge.kind === 'wire'
    ? [text(edge.from && edge.from.nodeId), text(edge.to && edge.to.nodeId)]
    : [text(edge && edge.fromNodeId), text(edge && edge.toNodeId)];
}

function descriptorFromPort(port) {
  const descriptor = portDescriptor(port);
  return descriptor && descriptor.type !== 'pulse' ? descriptor : null;
}

export function buildSubcircuitRevisionFromSelection(model, nodeIds, registry, previousRevision = null) {
  const selected = new Set(Array.from(nodeIds || [], text));
  const snapshot = model.snapshot();
  const selectedNodes = snapshot.nodes.filter((node) => selected.has(node.id));
  if (!selectedNodes.length) return null;
  const nodeById = new Map(snapshot.nodes.map((node) => [node.id, node]));
  const internalEdges = [];
  const boundary = new Map();
  const unresolvedPortIds = [];
  snapshot.edges.forEach((edge) => {
    const [fromId, toId] = edgeNodeIds(edge);
    const fromInside = selected.has(fromId); const toInside = selected.has(toId);
    if (fromInside && toInside) { internalEdges.push(clone(edge)); return; }
    if (edge.kind !== 'wire' || fromInside === toInside) return;
    const direction = toInside ? 'input' : 'output';
    const endpoint = direction === 'input' ? edge.to : edge.from;
    const endpointNode = nodeById.get(endpoint.nodeId);
    const endpointPort = endpointNode && registry.port(endpointNode, endpoint.portId, direction === 'input' ? 'input' : 'output');
    const channel = endpointPort && endpointPort.channel === 'event' ? 'event' : 'value';
    const key = direction + '\n' + endpoint.nodeId + '\n' + endpoint.portId;
    if (boundary.has(key)) return;
    let descriptor = null;
    if (channel === 'value') {
      const source = direction === 'input' ? edge.from : endpoint;
      descriptor = model.valueDescriptor(source.nodeId, source.portId) || descriptorFromPort(endpointPort);
    }
    const nodeLabel = endpointNode && endpointNode.label || endpoint.nodeId;
    boundary.set(key, {
      id: '', name: `${nodeLabel}.${endpointPort && endpointPort.label || endpoint.portId}`,
      direction, channel, valueType: channel === 'event' ? 'pulse' : descriptor && descriptor.type || 'number',
      ...(descriptor && descriptor.type === 'bits' ? { bitsWidth: descriptor.width } : {}),
      nodeId: endpoint.nodeId, portId: endpoint.portId,
      unresolved: channel === 'value' && !descriptor,
    });
  });
  const previous = previousRevision && Array.isArray(previousRevision.ports) ? previousRevision.ports : [];
  const usedPrevious = new Set();
  const ports = Array.from(boundary.values()).map((port) => {
    const compatible = (candidate) => !usedPrevious.has(candidate.id)
      && candidate.direction === port.direction && candidate.channel === port.channel
      && candidate.valueType === port.valueType
      && (candidate.valueType !== 'bits' || Number(candidate.bitsWidth) === Number(port.bitsWidth));
    const match = port.unresolved ? null
      : previous.find((candidate) => compatible(candidate) && candidate.name === port.name)
        || previous.find(compatible);
    const id = match ? match.id : generatedId('port');
    if (match) usedPrevious.add(match.id);
    if (port.unresolved) unresolvedPortIds.push(id);
    const clean = { ...port, id }; delete clean.unresolved; return clean;
  });
  const nodes = selectedNodes.map((node) => { const copy = clone(node); delete copy.savedState; return copy; });
  return { revision: { ports, nodes, edges: internalEdges }, unresolvedPortIds };
}

export function replaceSelectionWithSubcircuit(model, nodeIds, definition, revision) {
  const selected = new Set(Array.from(nodeIds || [], text));
  const snapshot = model.snapshot();
  const selectedNodes = snapshot.nodes.filter((node) => selected.has(node.id));
  if (!selectedNodes.length || !definition || !revision) return null;
  const left = Math.min(...selectedNodes.map((node) => node.x));
  const top = Math.min(...selectedNodes.map((node) => node.y));
  const right = Math.max(...selectedNodes.map((node) => node.x + node.width));
  const bottom = Math.max(...selectedNodes.map((node) => node.y + node.height));
  const instance = {
    id: generatedId('node'), type: 'subcircuit', label: definition.name,
    x: (left + right) / 2 - 96, y: (top + bottom) / 2 - 40,
    width: 192, height: Math.max(80, 48 + revision.ports.length * 18),
    config: { definitionId: definition.id, revision: revision.revision }, statePolicy: 'reset',
  };
  const portByBinding = new Map(revision.ports.map((port) => [port.direction + '\n' + port.nodeId + '\n' + port.portId, port]));
  const nextEdges = [];
  const relationKeys = new Set();
  snapshot.edges.forEach((edge) => {
    const [fromId, toId] = edgeNodeIds(edge);
    const fromInside = selected.has(fromId); const toInside = selected.has(toId);
    if (fromInside && toInside) return;
    if (!fromInside && !toInside) { nextEdges.push(clone(edge)); return; }
    if (edge.kind === 'wire') {
      const next = clone(edge);
      if (toInside) {
        const port = portByBinding.get('input\n' + edge.to.nodeId + '\n' + edge.to.portId);
        if (!port) return;
        next.to = { nodeId: instance.id, portId: port.id };
      } else {
        const port = portByBinding.get('output\n' + edge.from.nodeId + '\n' + edge.from.portId);
        if (!port) return;
        next.from = { nodeId: instance.id, portId: port.id };
      }
      nextEdges.push(next); return;
    }
    const next = { ...clone(edge), fromNodeId: fromInside ? instance.id : edge.fromNodeId, toNodeId: toInside ? instance.id : edge.toNodeId };
    if (next.fromNodeId === next.toNodeId) return;
    const key = next.fromNodeId + '\n' + next.toNodeId;
    if (relationKeys.has(key)) return;
    relationKeys.add(key); nextEdges.push(next);
  });
  const nextState = { nodes: snapshot.nodes.filter((node) => !selected.has(node.id)).concat(instance), edges: nextEdges };
  if (!model.replaceState(nextState, { kind: 'subcircuit-encapsulate', nodeIds: [instance.id] })) return null;
  return instance;
}

export function canUpgradeSubcircuitInstance(model, node, revision, registry) {
  if (!node || node.type !== 'subcircuit' || !revision) return { ok: false, blockers: [] };
  const currentPorts = new Map(registry.portsFor(node).map((port) => [port.id, port]));
  const nextNode = { ...node, config: { ...node.config, revision: revision.revision } };
  const nextPorts = new Map(registry.portsFor(nextNode).map((port) => [port.id, port]));
  const blockers = [];
  model.incidentEdgeIds(new Set([node.id])).forEach((edgeId) => {
    const edge = model.edge(edgeId);
    if (!edge || edge.kind !== 'wire') return;
    const portId = edge.from.nodeId === node.id ? edge.from.portId : edge.to.portId;
    const before = currentPorts.get(portId); const after = nextPorts.get(portId);
    if (!before || !after || before.direction !== after.direction || before.channel !== after.channel
      || JSON.stringify(before.types) !== JSON.stringify(after.types)
      || JSON.stringify(before.bitsWidths) !== JSON.stringify(after.bitsWidths)) blockers.push({ edgeId, portId });
  });
  return { ok: blockers.length === 0, blockers };
}

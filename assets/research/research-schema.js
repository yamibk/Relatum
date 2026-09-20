export const RESEARCH_VERSION = 2;

function issue(code, path, message, extra = {}) {
  return { code, path, message, ...extra };
}

function finite(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function normalizeNode(source, registry, errors, path, fallbackId) {
  const node = source && typeof source === 'object' ? source : {};
  const id = String(node.id || fallbackId);
  const type = String(node.type || '');
  const definition = registry.definition(type);
  if (!definition) errors.push(issue('unsupported-node-type', path + '.type', '不支持的研究节点：' + type, { nodeId: id }));
  const statePolicy = definition && definition.stateful && node.statePolicy === 'persist' ? 'persist' : 'reset';
  const normalized = {
    id,
    type,
    label: String(node.label || definition && (definition.defaultLabel || definition.label) || ''),
    x: finite(node.x),
    y: finite(node.y),
    width: Math.max(96, finite(node.width, 168)),
    height: Math.max(48, finite(node.height, 64)),
    config: registry.normalizeConfig(type, node.config),
    statePolicy,
  };
  if (statePolicy === 'persist' && node.savedState && typeof node.savedState === 'object') {
    normalized.savedState = clone(node.savedState);
  }
  return normalized;
}

function normalizeEdge(source, registry, nodeById, errors, path, fallbackId) {
  const edge = source && typeof source === 'object' ? source : {};
  const id = String(edge.id || fallbackId);
  if (edge.kind === 'wire') {
    const from = edge.from && typeof edge.from === 'object' ? edge.from : {};
    const to = edge.to && typeof edge.to === 'object' ? edge.to : {};
    const normalized = {
      id,
      kind: 'wire',
      from: { nodeId: String(from.nodeId || ''), portId: String(from.portId || '') },
      to: { nodeId: String(to.nodeId || ''), portId: String(to.portId || '') },
    };
    const fromNode = nodeById.get(normalized.from.nodeId);
    const toNode = nodeById.get(normalized.to.nodeId);
    if (!fromNode || !toNode) {
      errors.push(issue('dangling-edge', path, '导线端点不存在', { edgeId: id }));
    } else if (normalized.from.nodeId === normalized.to.nodeId) {
      errors.push(issue('self-edge', path, '导线不能连接节点自身', { edgeId: id }));
    } else if (!registry.compatiblePorts(fromNode, normalized.from.portId, toNode, normalized.to.portId)) {
      errors.push(issue('incompatible-wire', path, '导线端口方向、通道或类型不兼容', { edgeId: id }));
    }
    return normalized;
  }
  const fromNodeId = String(edge.fromNodeId || '');
  const toNodeId = String(edge.toNodeId || '');
  if (!fromNodeId || !toNodeId || !nodeById.has(fromNodeId) || !nodeById.has(toNodeId)) {
    errors.push(issue('dangling-edge', path, '关系线端点不存在', { edgeId: id }));
  } else if (fromNodeId === toNodeId) {
    errors.push(issue('self-edge', path, '关系线不能连接节点自身', { edgeId: id }));
  }
  return { id, kind: 'relation', fromNodeId, toNodeId };
}

function normalizePage(source, registry, errors, path, fallbackId) {
  const page = source && typeof source === 'object' ? source : {};
  const id = String(page.id || fallbackId);
  const nodes = [];
  const nodeById = new Map();
  (Array.isArray(page.nodes) ? page.nodes : []).forEach((node, index) => {
    const normalized = normalizeNode(node, registry, errors, `${path}.nodes[${index}]`, `node-${index + 1}`);
    if (nodeById.has(normalized.id)) {
      errors.push(issue('duplicate-node-id', `${path}.nodes[${index}].id`, '节点 ID 重复：' + normalized.id));
      return;
    }
    nodes.push(normalized);
    nodeById.set(normalized.id, normalized);
  });
  const edges = [];
  const edgeIds = new Set();
  const occupiedValueInputs = new Set();
  (Array.isArray(page.edges) ? page.edges : []).forEach((edge, index) => {
    const edgePath = `${path}.edges[${index}]`;
    const normalized = normalizeEdge(edge, registry, nodeById, errors, edgePath, `edge-${index + 1}`);
    if (edgeIds.has(normalized.id)) {
      errors.push(issue('duplicate-edge-id', edgePath + '.id', '连线 ID 重复：' + normalized.id));
      return;
    }
    edgeIds.add(normalized.id);
    if (normalized.kind === 'wire') {
      const targetNode = nodeById.get(normalized.to.nodeId);
      const targetPort = targetNode && registry.port(targetNode.type, normalized.to.portId, 'input');
      if (targetPort && targetPort.channel === 'value') {
        const key = normalized.to.nodeId + '\n' + normalized.to.portId;
        if (occupiedValueInputs.has(key)) {
          errors.push(issue('duplicate-value-input', edgePath, '值输入端口只能连接一条导线', {
            edgeId: normalized.id, nodeId: normalized.to.nodeId, portId: normalized.to.portId,
          }));
        }
        occupiedValueInputs.add(key);
      }
    }
    edges.push(normalized);
  });
  const view = page.view && typeof page.view === 'object' ? page.view : {};
  const simulation = page.simulation && typeof page.simulation === 'object' ? page.simulation : {};
  const allowedSpeeds = [0.25, 0.5, 1, 2, 4];
  return {
    id,
    title: String(page.title || ''),
    nodes,
    edges,
    view: {
      x: finite(view.x), y: finite(view.y),
      scale: Math.min(3.5, Math.max(0.18, finite(view.scale, 1))),
    },
    simulation: { speed: allowedSpeeds.includes(Number(simulation.speed)) ? Number(simulation.speed) : 1 },
  };
}

function normalizeDocument(source, registry, requireVersion) {
  if (!registry || typeof registry.definition !== 'function') throw new TypeError('需要研究节点注册表');
  const input = source && typeof source === 'object' ? source : {};
  const errors = [];
  if (requireVersion && input.researchVersion !== RESEARCH_VERSION) {
    errors.push(issue('unsupported-version', 'researchVersion', '不支持的研究数据版本：' + String(input.researchVersion)));
  }
  const rawPages = Array.isArray(input.pages) && input.pages.length ? input.pages : [{}];
  const pages = [];
  const pageIds = new Set();
  rawPages.forEach((page, index) => {
    const normalized = normalizePage(page, registry, errors, `pages[${index}]`, `research-page-${index + 1}`);
    if (pageIds.has(normalized.id)) {
      errors.push(issue('duplicate-page-id', `pages[${index}].id`, '页面 ID 重复：' + normalized.id));
      return;
    }
    pageIds.add(normalized.id);
    pages.push(normalized);
  });
  const requested = String(input.activePageId || '');
  return {
    ok: errors.length === 0,
    document: {
      researchVersion: RESEARCH_VERSION,
      pages,
      activePageId: pageIds.has(requested) ? requested : pages[0].id,
    },
    errors,
  };
}

export function createResearchDocument(source, registry) {
  return normalizeDocument(source, registry, false).document;
}

export function validateResearchDocument(source, registry) {
  return normalizeDocument(source, registry, true);
}

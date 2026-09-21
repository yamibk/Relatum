import {
  createResearchSubcircuitCatalog, expandResearchGraph, validateSubcircuitDependencies,
} from './research-subcircuits.js';

export const RESEARCH_VERSION = 3;

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
  if (type === 'subcircuit') {
    const catalog = registry.subcircuitCatalog();
    const config = node.config && typeof node.config === 'object' ? node.config : {};
    if (!catalog || !catalog.revision(config.definitionId, config.revision)) {
      errors.push(issue('missing-subcircuit-revision', path + '.config', '子电路实例引用了不存在的修订', { nodeId: id }));
    }
  }
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
  if ((statePolicy === 'persist' || type === 'subcircuit')
    && node.savedState && typeof node.savedState === 'object') {
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
      const targetPort = targetNode && registry.port(targetNode, normalized.to.portId, 'input');
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

function normalizeSubcircuitGraphs(catalog, registry, errors) {
  catalog.definitions().forEach((definition, definitionIndex) => {
    const newestRevision = definition.revisions.length
      ? definition.revisions[definition.revisions.length - 1].revision : 0;
    if (definition.latestRevision !== newestRevision) {
      errors.push(issue('invalid-latest-revision', `subcircuits[${definitionIndex}].latestRevision`, '最新修订必须指向最大修订号'));
    }
    definition.revisions.forEach((revision, revisionIndex) => {
      const path = `subcircuits[${definitionIndex}].revisions[${revisionIndex}]`;
      const nodes = [];
      const nodeById = new Map();
      revision.nodes.forEach((node, index) => {
        const normalized = normalizeNode(node, registry, errors, `${path}.nodes[${index}]`, `node-${index + 1}`);
        if (nodeById.has(normalized.id)) {
          errors.push(issue('duplicate-node-id', `${path}.nodes[${index}].id`, '节点 ID 重复：' + normalized.id));
          return;
        }
        delete normalized.savedState;
        nodes.push(normalized); nodeById.set(normalized.id, normalized);
      });
      const edges = [];
      const edgeIds = new Set();
      const occupiedValueInputs = new Set();
      revision.edges.forEach((edge, index) => {
        const edgePath = `${path}.edges[${index}]`;
        const normalized = normalizeEdge(edge, registry, nodeById, errors, edgePath, `edge-${index + 1}`);
        if (edgeIds.has(normalized.id)) {
          errors.push(issue('duplicate-edge-id', edgePath + '.id', '连线 ID 重复：' + normalized.id)); return;
        }
        edgeIds.add(normalized.id);
        if (normalized.kind === 'wire') {
          const targetNode = nodeById.get(normalized.to.nodeId);
          const targetPort = targetNode && registry.port(targetNode, normalized.to.portId, 'input');
          if (targetPort && targetPort.channel === 'value') {
            const key = normalized.to.nodeId + '\n' + normalized.to.portId;
            if (occupiedValueInputs.has(key)) errors.push(issue('duplicate-value-input', edgePath, '值输入端口只能连接一条导线'));
            occupiedValueInputs.add(key);
          }
        }
        edges.push(normalized);
      });
      revision.nodes = nodes; revision.edges = edges;
      revision.ports.forEach((port, portIndex) => {
        const node = nodeById.get(port.nodeId);
        const expectedDirection = port.direction === 'input' ? 'input' : 'output';
        const bound = node && registry.port(node, port.portId, expectedDirection);
        if (!bound) errors.push(issue('invalid-subcircuit-port-binding', `${path}.ports[${portIndex}]`, '子电路端口绑定不存在'));
        else if (bound.channel !== port.channel) errors.push(issue('invalid-subcircuit-port-channel', `${path}.ports[${portIndex}]`, '子电路端口通道与绑定不一致'));
        else if (port.channel === 'value' && !bound.types.includes('any') && !bound.types.includes(port.valueType)) {
          errors.push(issue('invalid-subcircuit-port-type', `${path}.ports[${portIndex}]`, '子电路端口类型与绑定不一致'));
        } else if (port.valueType === 'bits' && bound.bitsWidths.length && !bound.bitsWidths.includes(port.bitsWidth)) {
          errors.push(issue('invalid-subcircuit-port-width', `${path}.ports[${portIndex}]`, '子电路 Bits 位宽与绑定不一致'));
        }
      });
    });
  });
  validateSubcircuitDependencies(catalog).forEach((dependency) => {
    errors.push(issue(dependency.code, 'subcircuits', dependency.code === 'subcircuit-cycle'
      ? '子电路修订不能形成递归依赖' : dependency.code === 'subcircuit-depth'
        ? '子电路嵌套深度超过 32 层' : '子电路实例引用了不存在的修订'));
  });
}

function normalizeDocument(source, registry, requireVersion) {
  if (!registry || typeof registry.definition !== 'function') throw new TypeError('需要研究节点注册表');
  const input = source && typeof source === 'object' ? source : {};
  const errors = [];
  if (requireVersion && input.researchVersion !== RESEARCH_VERSION) {
    errors.push(issue('unsupported-version', 'researchVersion', '不支持的研究数据版本：' + String(input.researchVersion)));
  }
  const catalog = createResearchSubcircuitCatalog(input.subcircuits);
  registry.setSubcircuitCatalog(catalog);
  normalizeSubcircuitGraphs(catalog, registry, errors);
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
  pages.forEach((page, index) => {
    const expanded = expandResearchGraph(page, registry);
    expanded.errors.filter((error) => error.code === 'subcircuit-expansion-budget').forEach((error) => {
      errors.push(issue(error.code, `pages[${index}]`, error.message));
    });
  });
  const requested = String(input.activePageId || '');
  return {
    ok: errors.length === 0,
    document: {
      researchVersion: RESEARCH_VERSION,
      subcircuits: catalog.snapshot(),
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

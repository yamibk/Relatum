// AI 助手 V2 的零 DOM 画布数据层：
// - 生成带指纹、带截断报告的受限语义上下文；
// - 过滤预览中未勾选的操作并清理依赖连线；
// - 校验/转换严格导图与扩展子树；
// - 为普通网络生成确定性的局部布局。
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.RelatumAIPlanCanvas = factory();
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';

  const CONTEXT_TOTAL_CHARS = 60000;
  const CONTEXT_EDGE_LIMIT = 200;
  const SELECTION_NODE_LIMIT = 60;
  const SELECTION_NODE_CHARS = 2000;
  const CANVAS_NODE_LIMIT = 100;
  const CANVAS_NODE_CHARS = 600;
  const TITLE_LIMIT = 240;
  const EDGE_TEXT_LIMIT = 240;

  function text(value) {
    return String(value == null ? '' : value);
  }

  function finite(value, fallback) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
  }

  function fnv1a(value) {
    const source = text(value);
    let hash = 0x811c9dc5;
    for (let index = 0; index < source.length; index++) {
      hash ^= source.charCodeAt(index);
      hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0).toString(36) + '-' + source.length.toString(36);
  }

  function nodeFingerprint(node) {
    const source = node || {};
    return 'n2-' + fnv1a(JSON.stringify([
      text(source.id),
      text(source.kind || 'card'),
      text(source.title),
      text(source.body),
      !!source.mindmapMember,
      !!source.mindmapRoot,
    ]));
  }

  function edgeFingerprint(edge) {
    const source = edge || {};
    return 'e2-' + fnv1a(JSON.stringify([
      text(source.id),
      text(source.from),
      text(source.to),
      text(source.text),
    ]));
  }

  function uniqueStrings(values) {
    const seen = new Set();
    const out = [];
    (Array.isArray(values) ? values : []).forEach(function (value) {
      const id = text(value).trim();
      if (!id || seen.has(id)) return;
      seen.add(id);
      out.push(id);
    });
    return out;
  }

  function clipNode(source, perNodeLimit, totalRemaining) {
    const rawTitle = text(source.title);
    const rawBody = text(source.body);
    const budget = Math.max(0, Math.min(perNodeLimit, totalRemaining));
    const title = rawTitle.slice(0, Math.min(TITLE_LIMIT, budget));
    const bodyBudget = Math.max(0, budget - title.length);
    const body = rawBody.slice(0, bodyBudget);
    return {
      node: {
        id: text(source.id),
        kind: text(source.kind || 'card'),
        title: title,
        body: body,
        x: finite(source.x, 0),
        y: finite(source.y, 0),
        mindmapMember: !!source.mindmapMember,
        mindmapRoot: !!source.mindmapRoot,
        fingerprint: nodeFingerprint(source),
      },
      chars: title.length + body.length,
      titleTruncated: title.length < rawTitle.length,
      bodyTruncated: body.length < rawBody.length,
    };
  }

  function mindmapReport(nodes, edges) {
    const ids = nodes.map(function (node) { return node.id; });
    const idSet = new Set(ids);
    if (!ids.length) {
      return { valid: false, reason: 'empty', rootId: '', parents: [], maxDepth: 0 };
    }
    const internal = edges.filter(function (edge) {
      return edge.from !== edge.to && idSet.has(edge.from) && idSet.has(edge.to);
    });
    if (internal.length !== ids.length - 1) {
      return {
        valid: false,
        reason: 'edge-count',
        rootId: '',
        parents: [],
        maxDepth: 0,
      };
    }
    const indegree = new Map();
    const children = new Map();
    ids.forEach(function (id) {
      indegree.set(id, 0);
      children.set(id, []);
    });
    let multipleParents = false;
    internal.forEach(function (edge) {
      const next = (indegree.get(edge.to) || 0) + 1;
      indegree.set(edge.to, next);
      if (next > 1) multipleParents = true;
      children.get(edge.from).push(edge.to);
    });
    if (multipleParents) {
      return { valid: false, reason: 'multiple-parents', rootId: '', parents: [], maxDepth: 0 };
    }
    const roots = ids.filter(function (id) { return (indegree.get(id) || 0) === 0; });
    if (roots.length !== 1) {
      return { valid: false, reason: 'root-count', rootId: '', parents: [], maxDepth: 0 };
    }
    const rootId = roots[0];
    const visited = new Set();
    const visiting = new Set();
    const depth = new Map([[rootId, 0]]);
    let cycle = false;
    function walk(id) {
      if (visiting.has(id)) { cycle = true; return; }
      if (visited.has(id)) return;
      visiting.add(id);
      (children.get(id) || []).forEach(function (child) {
        depth.set(child, (depth.get(id) || 0) + 1);
        walk(child);
      });
      visiting.delete(id);
      visited.add(id);
    }
    walk(rootId);
    if (cycle || visited.size !== ids.length) {
      return {
        valid: false,
        reason: cycle ? 'cycle' : 'disconnected',
        rootId: rootId,
        parents: [],
        maxDepth: 0,
      };
    }
    const markedRootIds = nodes.filter(function (node) { return !!node.mindmapRoot; })
      .map(function (node) { return node.id; });
    if (markedRootIds.length > 1
        || (markedRootIds.length === 1 && markedRootIds[0] !== rootId)) {
      return {
        valid: false,
        reason: markedRootIds.length > 1 ? 'marked-root-count' : 'root-marker-mismatch',
        rootId: rootId,
        parents: internal.map(function (edge) {
          return { parentId: edge.from, childId: edge.to };
        }),
        maxDepth: Math.max.apply(null, Array.from(depth.values())),
        markedRootIds: markedRootIds,
      };
    }
    return {
      valid: true,
      reason: '',
      rootId: rootId,
      parents: internal.map(function (edge) {
        return { parentId: edge.from, childId: edge.to };
      }),
      maxDepth: Math.max.apply(null, Array.from(depth.values())),
      markedRootIds: markedRootIds,
    };
  }

  function describeContext(input, options) {
    const source = input && typeof input === 'object' ? input : {};
    const settings = options && typeof options === 'object' ? options : {};
    const scope = settings.scope === 'selection' ? 'selection' : 'canvas';
    const selectedIds = uniqueStrings(source.selectedIds);
    const selectedSet = new Set(selectedIds);
    const rawNodes = (Array.isArray(source.nodes) ? source.nodes : []).filter(function (node) {
      return node && typeof node === 'object' && text(node.id).trim()
        && (scope !== 'selection' || selectedSet.has(text(node.id)));
    });
    const nodeLimit = scope === 'selection' ? SELECTION_NODE_LIMIT : CANVAS_NODE_LIMIT;
    const perNodeLimit = scope === 'selection' ? SELECTION_NODE_CHARS : CANVAS_NODE_CHARS;
    const outNodes = [];
    const includedIds = new Set();
    let totalChars = 0;
    let fieldTruncations = 0;
    for (let index = 0; index < rawNodes.length && outNodes.length < nodeLimit; index++) {
      if (totalChars >= CONTEXT_TOTAL_CHARS) break;
      const clipped = clipNode(
        rawNodes[index],
        perNodeLimit,
        CONTEXT_TOTAL_CHARS - totalChars,
      );
      const node = clipped.node;
      outNodes.push(node);
      includedIds.add(node.id);
      totalChars += clipped.chars;
      if (clipped.titleTruncated) fieldTruncations += 1;
      if (clipped.bodyTruncated) fieldTruncations += 1;
    }
    const candidateEdges = (Array.isArray(source.edges) ? source.edges : []).filter(function (edge) {
      return edge && typeof edge === 'object' && text(edge.id).trim()
        && includedIds.has(text(edge.from)) && includedIds.has(text(edge.to))
        && text(edge.from) !== text(edge.to);
    });
    const outEdges = candidateEdges.slice(0, CONTEXT_EDGE_LIMIT).map(function (edge) {
      return {
        id: text(edge.id),
        from: text(edge.from),
        to: text(edge.to),
        text: text(edge.text).slice(0, EDGE_TEXT_LIMIT),
        fingerprint: edgeFingerprint(edge),
      };
    });
    const omittedNodes = Math.max(0, rawNodes.length - outNodes.length);
    const omittedEdges = Math.max(0, candidateEdges.length - outEdges.length);
    const truncation = {
      truncated: omittedNodes > 0 || omittedEdges > 0 || fieldTruncations > 0,
      scope: scope,
      includedNodes: outNodes.length,
      availableNodes: rawNodes.length,
      omittedNodes: omittedNodes,
      includedEdges: outEdges.length,
      availableEdges: candidateEdges.length,
      omittedEdges: omittedEdges,
      fieldTruncations: fieldTruncations,
      totalChars: totalChars,
      totalCharLimit: CONTEXT_TOTAL_CHARS,
      nodeLimit: nodeLimit,
      perNodeCharLimit: perNodeLimit,
      edgeLimit: CONTEXT_EDGE_LIMIT,
    };
    const result = {
      scope: scope,
      selectedIds: scope === 'selection'
        ? selectedIds.filter(function (id) { return includedIds.has(id); })
        : [],
      nodes: outNodes,
      edges: outEdges,
      truncation: truncation,
    };
    if (scope === 'selection') result.mindmap = mindmapReport(outNodes, outEdges);
    return result;
  }

  function requestedIndexes(values, length, defaultPredicate) {
    if (!Array.isArray(values)) {
      const defaults = new Set();
      for (let index = 0; index < length; index++) {
        if (!defaultPredicate || defaultPredicate(index)) defaults.add(index);
      }
      return defaults;
    }
    const selected = new Set();
    values.forEach(function (value) {
      const index = Number(value);
      if (Number.isInteger(index) && index >= 0 && index < length) selected.add(index);
    });
    return selected;
  }

  function cascadeMindmapNodeIndexes(plan, rawNodes, rawEdges, selectedIndexes) {
    if (!plan || (plan.action !== 'create_mindmap' && plan.action !== 'extend_branch')) {
      return selectedIndexes;
    }
    const indexByRef = new Map();
    rawNodes.forEach(function (node, index) {
      if (node && node.op === 'create') indexByRef.set(text(node.ref), index);
    });
    const declaredRoot = plan && plan.mindmap ? text(plan.mindmap.rootRef) : '';
    if (declaredRoot && indexByRef.has(declaredRoot)) {
      selectedIndexes.add(indexByRef.get(declaredRoot));
    }
    const children = new Map();
    indexByRef.forEach(function (_index, ref) { children.set(ref, []); });
    rawEdges.forEach(function (edge) {
      if (!edge || edge.op !== 'create' || !edge.from || !edge.to
          || edge.from.kind !== 'new' || edge.to.kind !== 'new') return;
      const parent = text(edge.from.ref);
      const child = text(edge.to.ref);
      if (children.has(parent) && indexByRef.has(child)) children.get(parent).push(child);
    });
    const excluded = [];
    indexByRef.forEach(function (index, ref) {
      if (!selectedIndexes.has(index)) excluded.push(ref);
    });
    for (let cursor = 0; cursor < excluded.length; cursor++) {
      (children.get(excluded[cursor]) || []).forEach(function (child) {
        const index = indexByRef.get(child);
        if (selectedIndexes.has(index)) {
          selectedIndexes.delete(index);
          excluded.push(child);
        }
      });
    }
    return selectedIndexes;
  }

  function selectOperations(plan, options) {
    const source = plan && typeof plan === 'object' ? plan : {};
    const settings = options && typeof options === 'object' ? options : {};
    const rawNodes = Array.isArray(source.nodes) ? source.nodes : [];
    const rawEdges = Array.isArray(source.edges) ? source.edges : [];
    const nodeIndexes = cascadeMindmapNodeIndexes(
      source,
      rawNodes,
      rawEdges,
      requestedIndexes(settings.nodeIndexes, rawNodes.length),
    );
    const edgeIndexes = requestedIndexes(
      settings.edgeIndexes,
      rawEdges.length,
      function (index) { return rawEdges[index] && rawEdges[index].op !== 'remove'; },
    );
    const nodes = [];
    const selectedRefs = new Set();
    rawNodes.forEach(function (node, index) {
      if (!nodeIndexes.has(index)) return;
      nodes.push({ index: index, item: node });
      if (node && node.op === 'create') selectedRefs.add(text(node.ref));
    });
    const edges = [];
    const droppedEdgeIndexes = [];
    rawEdges.forEach(function (edge, index) {
      if (!edgeIndexes.has(index)) return;
      let dependsOnMissingNode = false;
      ['from', 'to'].forEach(function (field) {
        const endpoint = edge && edge[field];
        if (endpoint && endpoint.kind === 'new' && !selectedRefs.has(text(endpoint.ref))) {
          dependsOnMissingNode = true;
        }
      });
      if (dependsOnMissingNode) {
        droppedEdgeIndexes.push(index);
        return;
      }
      edges.push({ index: index, item: edge });
    });
    return {
      nodes: nodes,
      edges: edges,
      selectedRefs: selectedRefs,
      droppedEdgeIndexes: droppedEdgeIndexes,
    };
  }

  function strictNewTree(nodeEntries, edgeEntries, declaredRoot) {
    const nodes = nodeEntries.map(function (entry) { return entry.item || entry; });
    const edges = edgeEntries.map(function (entry) { return entry.item || entry; });
    const refs = nodes.filter(function (node) { return node && node.op === 'create'; })
      .map(function (node) { return text(node.ref); });
    const refSet = new Set(refs);
    if (!refs.length || refSet.size !== refs.length) return { ok: false, reason: 'nodes' };
    const pairs = [];
    for (let index = 0; index < edges.length; index++) {
      const edge = edges[index];
      if (!edge || edge.op !== 'create' || !edge.from || !edge.to
          || edge.from.kind !== 'new' || edge.to.kind !== 'new') {
        return { ok: false, reason: 'edge-kind' };
      }
      const from = text(edge.from.ref);
      const to = text(edge.to.ref);
      if (!refSet.has(from) || !refSet.has(to) || from === to) {
        return { ok: false, reason: 'edge-reference' };
      }
      pairs.push({ from: from, to: to, text: text(edge.text) });
    }
    const report = mindmapReport(
      refs.map(function (ref) { return { id: ref }; }),
      pairs,
    );
    if (!report.valid) return { ok: false, reason: report.reason };
    if (declaredRoot && text(declaredRoot) !== report.rootId) {
      return { ok: false, reason: 'root-mismatch' };
    }
    const children = new Map();
    refs.forEach(function (ref) { children.set(ref, []); });
    pairs.forEach(function (pair) { children.get(pair.from).push(pair.to); });
    const byRef = new Map();
    nodes.forEach(function (node) { byRef.set(text(node.ref), node); });
    const ordered = [];
    const depth = new Map([[report.rootId, 0]]);
    const queue = [report.rootId];
    for (let index = 0; index < queue.length; index++) {
      const ref = queue[index];
      ordered.push(ref);
      (children.get(ref) || []).forEach(function (child) {
        depth.set(child, (depth.get(ref) || 0) + 1);
        queue.push(child);
      });
    }
    return {
      ok: true,
      rootRef: report.rootId,
      refs: ordered,
      nodes: ordered.map(function (ref) {
        const node = byRef.get(ref);
        return {
          ref: ref,
          title: text(node.title),
          body: text(node.body),
          depth: depth.get(ref) || 0,
        };
      }),
      edges: pairs,
      depth: depth,
    };
  }

  function mindmapOutline(plan, selected) {
    const source = plan && typeof plan === 'object' ? plan : {};
    const operations = selected || selectOperations(source, {});
    const tree = strictNewTree(
      operations.nodes,
      operations.edges,
      source.mindmap && source.mindmap.rootRef,
    );
    if (!tree.ok) return tree;
    if (tree.refs.length < 2) return { ok: false, reason: 'too-small' };
    const indexByRef = new Map();
    tree.refs.forEach(function (ref, index) { indexByRef.set(ref, index); });
    return {
      ok: true,
      refs: tree.refs,
      nodes: tree.nodes,
      edges: tree.edges.map(function (edge) {
        return {
          from: indexByRef.get(edge.from),
          to: indexByRef.get(edge.to),
          text: edge.text,
        };
      }),
      rootRef: tree.rootRef,
    };
  }

  function extensionSubtree(plan, selected) {
    const source = plan && typeof plan === 'object' ? plan : {};
    const operations = selected || selectOperations(source, {});
    const boundaries = [];
    const internal = [];
    operations.edges.forEach(function (entry) {
      const edge = entry.item;
      if (edge && edge.op === 'create' && edge.from && edge.to
          && edge.from.kind === 'existing' && edge.to.kind === 'new') {
        boundaries.push(edge);
      } else {
        internal.push(entry);
      }
    });
    if (boundaries.length !== 1) return { ok: false, reason: 'boundary' };
    const boundary = boundaries[0];
    const tree = strictNewTree(operations.nodes, internal, boundary.to.ref);
    if (!tree.ok) return tree;
    return {
      ok: true,
      anchorId: text(boundary.from.id),
      rootRef: text(boundary.to.ref),
      refs: tree.refs,
      nodes: tree.nodes,
      edges: [boundary].concat(tree.edges.map(function (edge) {
        return {
          op: 'create',
          from: { kind: 'new', ref: edge.from },
          to: { kind: 'new', ref: edge.to },
          text: edge.text,
        };
      })),
    };
  }

  function deterministicLayout(input) {
    const source = input && typeof input === 'object' ? input : {};
    const nodes = Array.isArray(source.nodes) ? source.nodes : [];
    const edges = Array.isArray(source.edges) ? source.edges : [];
    const movable = new Set(uniqueStrings(source.movableIds));
    const orderedIds = nodes.map(function (node) { return text(node.id); })
      .filter(function (id) { return movable.has(id); });
    const indegree = new Map();
    const children = new Map();
    orderedIds.forEach(function (id) {
      indegree.set(id, 0);
      children.set(id, []);
    });
    edges.forEach(function (edge) {
      const from = text(edge.from);
      const to = text(edge.to);
      if (!movable.has(to)) return;
      if (movable.has(from)) {
        children.get(from).push(to);
        indegree.set(to, (indegree.get(to) || 0) + 1);
      }
    });
    let roots = orderedIds.filter(function (id) { return (indegree.get(id) || 0) === 0; });
    if (!roots.length && orderedIds.length) roots = [orderedIds[0]];
    const depth = new Map();
    const queue = roots.slice();
    roots.forEach(function (id) { depth.set(id, 0); });
    for (let index = 0; index < queue.length; index++) {
      const id = queue[index];
      (children.get(id) || []).forEach(function (child) {
        const nextDepth = (depth.get(id) || 0) + 1;
        if (!depth.has(child) || nextDepth < depth.get(child)) {
          depth.set(child, nextDepth);
          queue.push(child);
        }
      });
    }
    orderedIds.forEach(function (id) {
      if (!depth.has(id)) depth.set(id, 0);
    });
    const maxDepth = orderedIds.reduce(function (max, id) {
      return Math.max(max, depth.get(id) || 0);
    }, 0);
    const layers = new Map();
    orderedIds.forEach(function (id) {
      const value = depth.get(id) || 0;
      if (!layers.has(value)) layers.set(value, []);
      layers.get(value).push(id);
    });
    const center = source.center || {};
    const centerX = finite(center.x, 0);
    const centerY = finite(center.y, 0);
    const columnGap = Math.max(180, finite(source.columnGap, 280));
    const rowGap = Math.max(100, finite(source.rowGap, 170));
    const positions = {};
    layers.forEach(function (ids, layer) {
      const x = centerX + (layer - maxDepth / 2) * columnGap;
      const top = centerY - ((ids.length - 1) * rowGap) / 2;
      ids.forEach(function (id, index) {
        positions[id] = {
          x: Math.round(x),
          y: Math.round(top + index * rowGap),
        };
      });
    });
    const occupied = nodes.filter(function (node) {
      return node && !movable.has(text(node.id));
    }).map(function (node) {
      return { x: finite(node.x, 0), y: finite(node.y, 0) };
    });
    orderedIds.forEach(function (id) {
      const point = positions[id];
      if (!point) return;
      let attempts = 0;
      while (attempts < 80 && occupied.some(function (other) {
        return Math.abs(other.x - point.x) < 220 && Math.abs(other.y - point.y) < 120;
      })) {
        point.y += rowGap;
        attempts += 1;
      }
      occupied.push({ x: point.x, y: point.y });
    });
    return positions;
  }

  return {
    CONTEXT_TOTAL_CHARS: CONTEXT_TOTAL_CHARS,
    CONTEXT_EDGE_LIMIT: CONTEXT_EDGE_LIMIT,
    SELECTION_NODE_LIMIT: SELECTION_NODE_LIMIT,
    CANVAS_NODE_LIMIT: CANVAS_NODE_LIMIT,
    nodeFingerprint: nodeFingerprint,
    edgeFingerprint: edgeFingerprint,
    describeContext: describeContext,
    mindmapReport: mindmapReport,
    selectOperations: selectOperations,
    mindmapOutline: mindmapOutline,
    extensionSubtree: extensionSubtree,
    deterministicLayout: deterministicLayout,
  };
});

(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.RelatumCanvasImport = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';

  const MAX_FILE_BYTES = 160 * 1024 * 1024;
  const DEFAULT_NODE_WIDTH = 160;
  const DEFAULT_NODE_HEIGHT = 36;

  function importError(code, message, details) {
    const error = new Error(message);
    error.code = code;
    error.details = details || {};
    return error;
  }

  function finite(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }

  function deepClone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function sourceId(raw, index) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw importError('INVALID_NODE', '画布中包含无效节点。', { index: index });
    }
    if (raw.id == null || !String(raw.id).trim()) {
      throw importError('MISSING_NODE_ID', '画布中存在缺少 ID 的节点。', { index: index });
    }
    return String(raw.id);
  }

  function hasAssetPath(node) {
    return !!node
      && typeof node === 'object'
      && Object.prototype.hasOwnProperty.call(node, 'assetPath');
  }

  function validatePayload(payload) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      throw importError('INVALID_PAYLOAD', '这不是有效的 .canvas 文件。');
    }
    if (!Array.isArray(payload.nodes)) {
      throw importError('MISSING_NODES', '这不是有效的 .canvas 文件（缺少 nodes）。');
    }
    if (payload.edges != null && !Array.isArray(payload.edges)) {
      throw importError('INVALID_EDGES', '这不是有效的 .canvas 文件（edges 格式错误）。');
    }
    if (payload.ink != null && (typeof payload.ink !== 'object' || Array.isArray(payload.ink))) {
      throw importError('INVALID_INK', '这不是有效的 .canvas 文件（ink 格式错误）。');
    }

    const ids = new Set();
    payload.nodes.forEach(function (node, index) {
      const id = sourceId(node, index);
      if (ids.has(id)) {
        throw importError('DUPLICATE_NODE_ID', '画布中存在重复的节点 ID。', { id: id });
      }
      ids.add(id);
    });
    return true;
  }

  function nextId(factory, seen, kind) {
    if (typeof factory !== 'function') {
      throw importError('MISSING_ID_FACTORY', '导入器缺少 ' + kind + ' ID 生成器。');
    }
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const value = String(factory() || '');
      if (value && !seen.has(value)) {
        seen.add(value);
        return value;
      }
    }
    throw importError('ID_COLLISION', '无法为导入内容生成唯一 ID。', { kind: kind });
  }

  function point(raw) {
    if (Array.isArray(raw)) {
      const x = finite(raw[0]);
      const y = finite(raw[1]);
      return x === null || y === null ? null : { x: x, y: y };
    }
    if (!raw || typeof raw !== 'object') return null;
    const x = finite(raw.x);
    const y = finite(raw.y);
    if (x === null || y === null) return null;
    const copy = deepClone(raw);
    copy.x = x;
    copy.y = y;
    return copy;
  }

  function translatePoint(raw, dx, dy) {
    const copy = point(raw);
    if (!copy) return null;
    copy.x += dx;
    copy.y += dy;
    return copy;
  }

  function createBounds() {
    return {
      minX: Infinity,
      minY: Infinity,
      maxX: -Infinity,
      maxY: -Infinity,
    };
  }

  function includePoint(bounds, raw) {
    const p = point(raw);
    if (!p) return false;
    bounds.minX = Math.min(bounds.minX, p.x);
    bounds.minY = Math.min(bounds.minY, p.y);
    bounds.maxX = Math.max(bounds.maxX, p.x);
    bounds.maxY = Math.max(bounds.maxY, p.y);
    return true;
  }

  function includeNode(bounds, node) {
    const x = finite(node.x);
    const y = finite(node.y);
    const width = finite(node.width);
    const height = finite(node.height);
    const nx = x === null ? 0 : x;
    const ny = y === null ? 0 : y;
    const w = width !== null && width > 0 ? width : DEFAULT_NODE_WIDTH;
    const h = height !== null && height > 0 ? height : DEFAULT_NODE_HEIGHT;
    includePoint(bounds, { x: nx, y: ny });
    includePoint(bounds, { x: nx + w, y: ny + h });
  }

  function boundsReady(bounds) {
    return Number.isFinite(bounds.minX)
      && Number.isFinite(bounds.minY)
      && Number.isFinite(bounds.maxX)
      && Number.isFinite(bounds.maxY);
  }

  function normalizeStroke(raw, idFactory, reservedInkIds, bounds) {
    if (!raw || typeof raw !== 'object' || !Array.isArray(raw.points)) {
      throw importError('INVALID_INK', '画布中包含无效的手写笔画。');
    }
    const points = raw.points.map(point);
    if (points.some(function (item) { return !item; }) || !points.length) {
      throw importError('INVALID_INK', '画布中包含无效的手写笔画坐标。');
    }
    const copy = deepClone(raw);
    copy.id = nextId(idFactory, reservedInkIds, 'ink');
    copy.points = points;
    points.forEach(function (item) { includePoint(bounds, item); });
    return copy;
  }

  function normalizeArrow(raw, idFactory, reservedInkIds, bounds) {
    if (!raw || typeof raw !== 'object') {
      throw importError('INVALID_INK', '画布中包含无效的自由箭头。');
    }
    const start = point(raw.start);
    const end = point(raw.end);
    if (!start || !end) {
      throw importError('INVALID_INK', '画布中包含无效的自由箭头坐标。');
    }
    const copy = deepClone(raw);
    copy.id = nextId(idFactory, reservedInkIds, 'ink');
    copy.start = start;
    copy.end = end;
    includePoint(bounds, start);
    includePoint(bounds, end);
    if (raw.control != null) {
      copy.control = point(raw.control);
      if (!copy.control) throw importError('INVALID_INK', '画布中包含无效的箭头控制点。');
      includePoint(bounds, copy.control);
    }
    if (raw.waypoints != null) {
      if (!Array.isArray(raw.waypoints)) {
        throw importError('INVALID_INK', '画布中包含无效的箭头折点。');
      }
      copy.waypoints = raw.waypoints.map(point);
      if (copy.waypoints.some(function (item) { return !item; })) {
        throw importError('INVALID_INK', '画布中包含无效的箭头折点。');
      }
      copy.waypoints.forEach(function (item) { includePoint(bounds, item); });
    }
    return copy;
  }

  function prepare(payload, options) {
    validatePayload(payload);
    const opts = options || {};
    const assetPolicy = opts.assetPolicy === 'include'
      ? 'include'
      : (opts.assetPolicy === 'skip' ? 'skip' : 'reject');
    const sourceNodes = payload.nodes;
    const sourceEdges = Array.isArray(payload.edges) ? payload.edges : [];
    const sourceInk = payload.ink && typeof payload.ink === 'object' ? payload.ink : {};
    if (sourceInk.strokes != null && !Array.isArray(sourceInk.strokes)) {
      throw importError('INVALID_INK', '这不是有效的 .canvas 文件（strokes 格式错误）。');
    }
    if (sourceInk.arrows != null && !Array.isArray(sourceInk.arrows)) {
      throw importError('INVALID_INK', '这不是有效的 .canvas 文件（arrows 格式错误）。');
    }

    const assetNodes = sourceNodes.filter(hasAssetPath);
    if (assetPolicy === 'reject' && assetNodes.length) {
      throw importError(
        'ASSETS_UNSUPPORTED',
        '源画布包含当前版本无法复制的图片或附件。',
        { assetCount: assetNodes.length },
      );
    }

    const importEntries = sourceNodes
      .map(function (node, index) { return { node: node, index: index }; })
      .filter(function (entry) {
        if (entry.node && (entry.node.kind === 'task-root' || entry.node.kind === 'taskbook')) {
          return false;
        }
        return assetPolicy === 'include' || !hasAssetPath(entry.node);
      });
    const reservedNodeIds = opts.reservedNodeIds || new Set();
    const reservedEdgeIds = opts.reservedEdgeIds || new Set();
    const reservedInkIds = opts.reservedInkIds || new Set();
    const idMap = new Map();
    importEntries.forEach(function (entry) {
      idMap.set(sourceId(entry.node, entry.index), nextId(
        opts.newNodeId,
        reservedNodeIds,
        'node',
      ));
    });

    const bounds = createBounds();
    const nodes = importEntries.map(function (entry) {
      const raw = entry.node;
      const copy = deepClone(raw);
      copy.id = idMap.get(String(raw.id));
      copy.x = finite(raw.x) === null ? 0 : finite(raw.x);
      copy.y = finite(raw.y) === null ? 0 : finite(raw.y);
      if (Array.isArray(raw.groupMemberIds)) {
        copy.groupMemberIds = raw.groupMemberIds
          .map(function (id) { return idMap.get(String(id)); })
          .filter(Boolean);
        if (!copy.groupMemberIds.length) delete copy.groupMemberIds;
      } else if (Object.prototype.hasOwnProperty.call(copy, 'groupMemberIds')) {
        delete copy.groupMemberIds;
      }
      if (raw.textBindTarget != null) {
        const bindTarget = idMap.get(String(raw.textBindTarget));
        if (bindTarget) {
          copy.textBindTarget = bindTarget;
        } else {
          delete copy.textBindTarget;
          delete copy.textBindDx;
          delete copy.textBindDy;
        }
      }
      includeNode(bounds, copy);
      return copy;
    });

    let skippedEdges = 0;
    const edges = [];
    sourceEdges.forEach(function (raw) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        skippedEdges += 1;
        return;
      }
      if (raw.role === 'task-workflow' || raw.role === 'taskbook-workflow') {
        skippedEdges += 1;
        return;
      }
      const from = idMap.get(String(raw.from));
      const to = idMap.get(String(raw.to));
      if (!from || !to || from === to) {
        skippedEdges += 1;
        return;
      }
      const copy = deepClone(raw);
      copy.id = nextId(opts.newEdgeId, reservedEdgeIds, 'edge');
      copy.from = from;
      copy.to = to;
      if (raw.waypoints != null) {
        if (!Array.isArray(raw.waypoints)) {
          throw importError('INVALID_EDGE', '画布中包含无效的连线折点。');
        }
        copy.waypoints = raw.waypoints.map(point);
        if (copy.waypoints.some(function (item) { return !item; })) {
          throw importError('INVALID_EDGE', '画布中包含无效的连线折点。');
        }
      }
      edges.push(copy);
    });

    const strokes = (sourceInk.strokes || []).map(function (stroke) {
      return normalizeStroke(stroke, opts.newInkId, reservedInkIds, bounds);
    });
    const arrows = (sourceInk.arrows || []).map(function (arrow) {
      return normalizeArrow(arrow, opts.newInkId, reservedInkIds, bounds);
    });

    if (!nodes.length && !strokes.length && !arrows.length) {
      throw importError(
        'EMPTY_IMPORT',
        assetNodes.length
          ? '这张画布里只有无法复制的图片或附件。'
          : '这张画布没有可复制的内容。',
        { assetCount: assetNodes.length },
      );
    }

    const dropX = finite(opts.dropPoint && opts.dropPoint.x);
    const dropY = finite(opts.dropPoint && opts.dropPoint.y);
    const target = {
      x: dropX === null ? 0 : dropX,
      y: dropY === null ? 0 : dropY,
    };
    const offset = boundsReady(bounds)
      ? {
        x: target.x - (bounds.minX + bounds.maxX) / 2,
        y: target.y - (bounds.minY + bounds.maxY) / 2,
      }
      : { x: 0, y: 0 };

    nodes.forEach(function (node) {
      node.x = Math.round(node.x + offset.x);
      node.y = Math.round(node.y + offset.y);
    });
    edges.forEach(function (edge) {
      if (Array.isArray(edge.waypoints)) {
        edge.waypoints = edge.waypoints.map(function (item) {
          return translatePoint(item, offset.x, offset.y);
        });
      }
    });
    strokes.forEach(function (stroke) {
      stroke.points = stroke.points.map(function (item) {
        return translatePoint(item, offset.x, offset.y);
      });
    });
    arrows.forEach(function (arrow) {
      arrow.start = translatePoint(arrow.start, offset.x, offset.y);
      arrow.end = translatePoint(arrow.end, offset.x, offset.y);
      if (arrow.control) arrow.control = translatePoint(arrow.control, offset.x, offset.y);
      if (Array.isArray(arrow.waypoints)) {
        arrow.waypoints = arrow.waypoints.map(function (item) {
          return translatePoint(item, offset.x, offset.y);
        });
      }
    });

    return {
      nodes: nodes,
      edges: edges,
      ink: { version: 1, strokes: strokes, arrows: arrows },
      meta: {
        assetCount: assetNodes.length,
        skippedAssets: assetPolicy === 'skip' ? assetNodes.length : 0,
        skippedEdges: skippedEdges,
        nodeCount: nodes.length,
        edgeCount: edges.length,
        strokeCount: strokes.length,
        arrowCount: arrows.length,
        offset: offset,
      },
    };
  }

  return {
    MAX_FILE_BYTES: MAX_FILE_BYTES,
    validatePayload: validatePayload,
    prepare: prepare,
  };
});

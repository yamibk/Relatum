const SVG_NS = 'http://www.w3.org/2000/svg';
const EDGE_GRID_SIZE = 512;
const MIN_SCALE = 0.18;
const MAX_SCALE = 3.5;
const DRAG_THRESHOLD = 4;

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function distanceToSegment(point, start, end) {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  if (!dx && !dy) return Math.hypot(point.x - start.x, point.y - start.y);
  const t = clamp(((point.x - start.x) * dx + (point.y - start.y) * dy) / (dx * dx + dy * dy), 0, 1);
  return Math.hypot(point.x - (start.x + dx * t), point.y - (start.y + dy * t));
}

function isEditableTarget(target) {
  return !!(target && target.closest && target.closest('[contenteditable="true"], input, textarea, select'));
}

export function createResearchCanvas(options) {
  const stage = options.stage;
  const model = options.model;
  const viewport = stage && stage.querySelector('[data-research-viewport]');
  const surface = stage && stage.querySelector('[data-research-surface]');
  const edgesCanvas = stage && stage.querySelector('[data-research-edges]');
  const activeSvg = stage && stage.querySelector('[data-research-active-edges]');
  const selectionFrame = stage && stage.querySelector('[data-research-selection-frame]');
  const minimap = stage && stage.querySelector('[data-research-minimap]');
  const minimapNodes = stage && stage.querySelector('[data-research-minimap-nodes]');
  const minimapViewbox = stage && stage.querySelector('[data-research-minimap-viewbox]');

  if (!viewport || !surface || !edgesCanvas || !activeSvg || !selectionFrame
    || !minimap || !minimapNodes || !minimapViewbox || !model) {
    throw new Error('研究画布 DOM 不完整');
  }

  const context = edgesCanvas.getContext('2d');
  const nodeElements = new Map();
  const edgePathCache = new Map();
  const edgeSpatialGrid = new Map();
  const selectedNodeIds = new Set();
  const selectedEdgeIds = new Set();
  let camera = { x: 0, y: 0, scale: 1 };
  let minimapMapping = null;
  let active = false;
  let disposed = false;
  let activeController = null;
  let resizeObserver = null;
  let drawRaf = 0;
  let gesture = null;
  let editing = null;
  let spaceHeld = false;
  let lastPointer = null;

  function viewportRect() {
    return viewport.getBoundingClientRect();
  }

  function eventPoint(event) {
    const rect = viewportRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }

  function screenToWorld(point) {
    return {
      x: (point.x - camera.x) / camera.scale,
      y: (point.y - camera.y) / camera.scale,
    };
  }

  function worldToScreen(point) {
    return {
      x: point.x * camera.scale + camera.x,
      y: point.y * camera.scale + camera.y,
    };
  }

  function nodeCenter(node) {
    return { x: node.x + node.width / 2, y: node.y + node.height / 2 };
  }

  function applyCamera() {
    surface.style.transform = `translate(${camera.x}px, ${camera.y}px) scale(${camera.scale})`;
    scheduleDraw();
    renderActiveEdges();
    updateMinimapViewbox();
  }

  function setCamera(next) {
    camera = {
      x: Number.isFinite(next.x) ? next.x : camera.x,
      y: Number.isFinite(next.y) ? next.y : camera.y,
      scale: clamp(Number.isFinite(next.scale) ? next.scale : camera.scale, MIN_SCALE, MAX_SCALE),
    };
    applyCamera();
  }

  function zoomAt(nextScale, screenPoint) {
    const scale = clamp(nextScale, MIN_SCALE, MAX_SCALE);
    const world = screenToWorld(screenPoint);
    setCamera({
      x: screenPoint.x - world.x * scale,
      y: screenPoint.y - world.y * scale,
      scale,
    });
  }

  function resetZoom() {
    const rect = viewportRect();
    zoomAt(1, { x: rect.width / 2, y: rect.height / 2 });
  }

  function fitToContent() {
    const nodes = model.nodes();
    if (!nodes.length) {
      setCamera({ x: 0, y: 0, scale: 1 });
      return;
    }
    const bounds = nodes.reduce((result, node) => ({
      left: Math.min(result.left, node.x),
      top: Math.min(result.top, node.y),
      right: Math.max(result.right, node.x + node.width),
      bottom: Math.max(result.bottom, node.y + node.height),
    }), { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity });
    const rect = viewportRect();
    const padding = 92;
    const scale = clamp(Math.min(
      Math.max(1, rect.width - padding * 2) / Math.max(1, bounds.right - bounds.left),
      Math.max(1, rect.height - padding * 2) / Math.max(1, bounds.bottom - bounds.top),
    ), MIN_SCALE, 1.5);
    setCamera({
      x: rect.width / 2 - ((bounds.left + bounds.right) / 2) * scale,
      y: rect.height / 2 - ((bounds.top + bounds.bottom) / 2) * scale,
      scale,
    });
  }

  function resizeCanvas() {
    const rect = viewportRect();
    const ratio = Math.max(1, window.devicePixelRatio || 1);
    const width = Math.max(1, Math.round(rect.width * ratio));
    const height = Math.max(1, Math.round(rect.height * ratio));
    if (edgesCanvas.width !== width || edgesCanvas.height !== height) {
      edgesCanvas.width = width;
      edgesCanvas.height = height;
      edgesCanvas.style.width = rect.width + 'px';
      edgesCanvas.style.height = rect.height + 'px';
    }
    scheduleDraw();
    updateMinimapViewbox();
  }

  function createNodeElement(node) {
    const element = document.createElement('article');
    element.className = 'research-node';
    element.dataset.nodeId = node.id;
    element.tabIndex = -1;
    element.setAttribute('role', 'group');
    const text = document.createElement('div');
    text.className = 'research-node-text';
    text.dataset.nodeText = '';
    element.appendChild(text);
    surface.appendChild(element);
    nodeElements.set(node.id, element);
    renderNode(node);
    return element;
  }

  function renderNode(node) {
    let element = nodeElements.get(node.id);
    if (!element) element = createNodeElement(node);
    element.style.transform = `translate(${node.x}px, ${node.y}px)`;
    element.style.width = node.width + 'px';
    element.style.minHeight = node.height + 'px';
    element.classList.toggle('is-selected', selectedNodeIds.has(node.id));
    element.setAttribute('aria-label', node.text || '节点');
    const text = element.querySelector('[data-node-text]');
    if (!editing || editing.nodeId !== node.id) text.textContent = node.text;
  }

  function syncNodeElements() {
    const nodes = model.nodes();
    const liveIds = new Set(nodes.map((node) => node.id));
    nodeElements.forEach((element, nodeId) => {
      if (liveIds.has(nodeId)) return;
      element.remove();
      nodeElements.delete(nodeId);
      selectedNodeIds.delete(nodeId);
    });
    nodes.forEach(renderNode);
    selectedEdgeIds.forEach((edgeId) => {
      if (!model.edge(edgeId)) selectedEdgeIds.delete(edgeId);
    });
  }

  function edgeGeometry(edge) {
    const from = model.node(edge.from);
    const to = model.node(edge.to);
    if (!from || !to) return null;
    const start = nodeCenter(from);
    const end = nodeCenter(to);
    return {
      id: edge.id,
      start,
      end,
      bounds: {
        left: Math.min(start.x, end.x),
        top: Math.min(start.y, end.y),
        right: Math.max(start.x, end.x),
        bottom: Math.max(start.y, end.y),
      },
    };
  }

  function gridKey(x, y) {
    return x + ':' + y;
  }

  function addEdgeToGrid(geometry) {
    const minX = Math.floor(geometry.bounds.left / EDGE_GRID_SIZE);
    const maxX = Math.floor(geometry.bounds.right / EDGE_GRID_SIZE);
    const minY = Math.floor(geometry.bounds.top / EDGE_GRID_SIZE);
    const maxY = Math.floor(geometry.bounds.bottom / EDGE_GRID_SIZE);
    for (let y = minY; y <= maxY; y += 1) {
      for (let x = minX; x <= maxX; x += 1) {
        const key = gridKey(x, y);
        if (!edgeSpatialGrid.has(key)) edgeSpatialGrid.set(key, new Set());
        edgeSpatialGrid.get(key).add(geometry.id);
      }
    }
  }

  function rebuildEdgeCache() {
    edgePathCache.clear();
    edgeSpatialGrid.clear();
    model.edges().forEach((edge) => {
      const geometry = edgeGeometry(edge);
      if (!geometry) return;
      edgePathCache.set(edge.id, geometry);
      addEdgeToGrid(geometry);
    });
  }

  function edgeIdsInBounds(bounds) {
    const ids = new Set();
    const minX = Math.floor(bounds.left / EDGE_GRID_SIZE);
    const maxX = Math.floor(bounds.right / EDGE_GRID_SIZE);
    const minY = Math.floor(bounds.top / EDGE_GRID_SIZE);
    const maxY = Math.floor(bounds.bottom / EDGE_GRID_SIZE);
    for (let y = minY; y <= maxY; y += 1) {
      for (let x = minX; x <= maxX; x += 1) {
        const bucket = edgeSpatialGrid.get(gridKey(x, y));
        if (bucket) bucket.forEach((edgeId) => ids.add(edgeId));
      }
    }
    return ids;
  }

  function scheduleDraw() {
    if (!active || drawRaf) return;
    drawRaf = requestAnimationFrame(drawEdges);
  }

  function drawEdges() {
    drawRaf = 0;
    const rect = viewportRect();
    const ratio = Math.max(1, window.devicePixelRatio || 1);
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.clearRect(0, 0, rect.width, rect.height);
    const topLeft = screenToWorld({ x: 0, y: 0 });
    const bottomRight = screenToWorld({ x: rect.width, y: rect.height });
    const candidates = edgeIdsInBounds({
      left: Math.min(topLeft.x, bottomRight.x),
      top: Math.min(topLeft.y, bottomRight.y),
      right: Math.max(topLeft.x, bottomRight.x),
      bottom: Math.max(topLeft.y, bottomRight.y),
    });
    const movingEdges = gesture && gesture.type === 'node-drag' ? gesture.edgeIds : null;
    const rootStyle = getComputedStyle(document.documentElement);
    const selectedStroke = rootStyle.getPropertyValue('--research-selection').trim() || '#11120f';
    const regularStroke = rootStyle.getPropertyValue('--research-line').trim() || 'rgba(37,39,36,.62)';
    candidates.forEach((edgeId) => {
      if (movingEdges && movingEdges.has(edgeId)) return;
      const geometry = edgePathCache.get(edgeId);
      if (!geometry) return;
      const start = worldToScreen(geometry.start);
      const end = worldToScreen(geometry.end);
      context.beginPath();
      context.moveTo(start.x, start.y);
      context.lineTo(end.x, end.y);
      context.lineWidth = selectedEdgeIds.has(edgeId) ? 2.4 : 1.35;
      context.strokeStyle = selectedEdgeIds.has(edgeId) ? selectedStroke : regularStroke;
      context.stroke();
    });
  }

  function clearActiveEdges() {
    activeSvg.replaceChildren();
  }

  function appendActiveLine(start, end, preview) {
    const line = document.createElementNS(SVG_NS, 'line');
    line.setAttribute('x1', String(start.x));
    line.setAttribute('y1', String(start.y));
    line.setAttribute('x2', String(end.x));
    line.setAttribute('y2', String(end.y));
    if (preview) line.classList.add('is-preview');
    activeSvg.appendChild(line);
  }

  function renderActiveEdges() {
    clearActiveEdges();
    if (!gesture) return;
    if (gesture.type === 'node-drag') {
      gesture.edgeIds.forEach((edgeId) => {
        const edge = model.edge(edgeId);
        const geometry = edge && edgeGeometry(edge);
        if (geometry) appendActiveLine(worldToScreen(geometry.start), worldToScreen(geometry.end), false);
      });
    } else if (gesture.type === 'edge-create') {
      const from = model.node(gesture.fromId);
      if (from) appendActiveLine(worldToScreen(nodeCenter(from)), gesture.current, true);
    }
  }

  function hitEdge(screenPoint) {
    const world = screenToWorld(screenPoint);
    const tolerance = 8 / camera.scale;
    const ids = edgeIdsInBounds({
      left: world.x - tolerance,
      top: world.y - tolerance,
      right: world.x + tolerance,
      bottom: world.y + tolerance,
    });
    let closest = null;
    let distance = Infinity;
    ids.forEach((edgeId) => {
      const geometry = edgePathCache.get(edgeId);
      if (!geometry) return;
      const nextDistance = distanceToSegment(world, geometry.start, geometry.end);
      if (nextDistance <= tolerance && nextDistance < distance) {
        closest = edgeId;
        distance = nextDistance;
      }
    });
    return closest;
  }

  function renderSelection() {
    nodeElements.forEach((element, nodeId) => {
      element.classList.toggle('is-selected', selectedNodeIds.has(nodeId));
    });
    scheduleDraw();
  }

  function clearSelection() {
    selectedNodeIds.clear();
    selectedEdgeIds.clear();
    renderSelection();
  }

  function selectOnlyNode(nodeId) {
    selectedNodeIds.clear();
    selectedEdgeIds.clear();
    selectedNodeIds.add(nodeId);
    renderSelection();
  }

  function createNodeAt(worldPoint, options = {}) {
    const source = {
      x: worldPoint.x - 84,
      y: worldPoint.y - 32,
      text: options.text || '',
    };
    const node = options.fromId
      ? model.createLinkedNode(options.fromId, source)
      : model.createNode(source);
    if (!node) return null;
    selectOnlyNode(node.id);
    if (options.edit !== false) beginEdit(node.id, options.replaceText);
    return node;
  }

  function beginEdit(nodeId, replaceText) {
    const node = model.node(nodeId);
    const element = nodeElements.get(nodeId);
    if (!node || !element) return false;
    if (editing && editing.nodeId !== nodeId) commitEdit();
    const text = element.querySelector('[data-node-text]');
    editing = { nodeId, originalText: node.text };
    element.classList.add('is-editing');
    text.contentEditable = 'true';
    text.spellcheck = false;
    text.textContent = replaceText == null ? node.text : String(replaceText);
    text.focus({ preventScroll: true });
    const selection = window.getSelection();
    if (selection) {
      const range = document.createRange();
      range.selectNodeContents(text);
      range.collapse(false);
      selection.removeAllRanges();
      selection.addRange(range);
    }
    return true;
  }

  function finishEditElement(nodeId) {
    const element = nodeElements.get(nodeId);
    if (!element) return;
    const text = element.querySelector('[data-node-text]');
    text.contentEditable = 'false';
    element.classList.remove('is-editing');
  }

  function commitEdit() {
    if (!editing) return false;
    const state = editing;
    const element = nodeElements.get(state.nodeId);
    const text = element && element.querySelector('[data-node-text]');
    const value = text ? text.textContent.replace(/\r\n?/g, '\n') : state.originalText;
    const height = element ? Math.max(64, Math.ceil(element.scrollHeight)) : 64;
    editing = null;
    finishEditElement(state.nodeId);
    model.updateNode(state.nodeId, { text: value, height });
    return true;
  }

  function cancelEdit() {
    if (!editing) return false;
    const state = editing;
    editing = null;
    finishEditElement(state.nodeId);
    const node = model.node(state.nodeId);
    if (node) renderNode(node);
    return true;
  }

  function updateFrame(start, current) {
    const left = Math.min(start.x, current.x);
    const top = Math.min(start.y, current.y);
    const right = Math.max(start.x, current.x);
    const bottom = Math.max(start.y, current.y);
    selectionFrame.hidden = false;
    selectionFrame.style.left = left + 'px';
    selectionFrame.style.top = top + 'px';
    selectionFrame.style.width = right - left + 'px';
    selectionFrame.style.height = bottom - top + 'px';
    const worldStart = screenToWorld({ x: left, y: top });
    const worldEnd = screenToWorld({ x: right, y: bottom });
    selectedNodeIds.clear();
    if (gesture.additive) gesture.baseline.forEach((nodeId) => selectedNodeIds.add(nodeId));
    model.nodes().forEach((node) => {
      if (node.x + node.width >= worldStart.x && node.x <= worldEnd.x
        && node.y + node.height >= worldStart.y && node.y <= worldEnd.y) {
        selectedNodeIds.add(node.id);
      }
    });
    selectedEdgeIds.clear();
    renderSelection();
  }

  function startNodeDrag(event, nodeId) {
    const point = eventPoint(event);
    const toggle = event.ctrlKey || event.metaKey || event.shiftKey;
    if (toggle) {
      if (selectedNodeIds.has(nodeId)) selectedNodeIds.delete(nodeId);
      else selectedNodeIds.add(nodeId);
      selectedEdgeIds.clear();
      renderSelection();
      if (!selectedNodeIds.has(nodeId)) return;
    } else if (!selectedNodeIds.has(nodeId)) {
      selectOnlyNode(nodeId);
    }
    const positions = {};
    selectedNodeIds.forEach((id) => {
      const node = model.node(id);
      if (node) positions[id] = { x: node.x, y: node.y };
    });
    gesture = {
      type: 'node-drag',
      pointerId: event.pointerId,
      start: point,
      positions,
      before: model.capture(),
      edgeIds: model.incidentEdgeIds(selectedNodeIds),
      moved: false,
    };
    const element = nodeElements.get(nodeId);
    if (element) element.classList.add('is-dragging');
    viewport.setPointerCapture(event.pointerId);
  }

  function startEdgeCreate(event, nodeId) {
    selectedEdgeIds.clear();
    if (!selectedNodeIds.has(nodeId)) selectOnlyNode(nodeId);
    gesture = {
      type: 'edge-create',
      pointerId: event.pointerId,
      fromId: nodeId,
      current: eventPoint(event),
    };
    viewport.setPointerCapture(event.pointerId);
    renderActiveEdges();
  }

  function startBackgroundGesture(event) {
    const point = eventPoint(event);
    const edgeId = hitEdge(point);
    if (edgeId) {
      if (event.ctrlKey || event.metaKey || event.shiftKey) {
        if (selectedEdgeIds.has(edgeId)) selectedEdgeIds.delete(edgeId);
        else selectedEdgeIds.add(edgeId);
      } else {
        selectedNodeIds.clear();
        selectedEdgeIds.clear();
        selectedEdgeIds.add(edgeId);
      }
      renderSelection();
      return;
    }
    const additive = event.ctrlKey || event.metaKey || event.shiftKey;
    gesture = {
      type: 'box',
      pointerId: event.pointerId,
      start: point,
      current: point,
      additive,
      baseline: new Set(selectedNodeIds),
      moved: false,
    };
    if (!additive) clearSelection();
    viewport.setPointerCapture(event.pointerId);
  }

  function startPan(event) {
    gesture = {
      type: 'pan',
      pointerId: event.pointerId,
      start: eventPoint(event),
      camera: { ...camera },
    };
    viewport.classList.add('is-panning');
    viewport.setPointerCapture(event.pointerId);
  }

  function onPointerDown(event) {
    if (event.button !== 0 && event.button !== 1) return;
    lastPointer = eventPoint(event);
    if (editing && !event.target.closest(`[data-node-id="${CSS.escape(editing.nodeId)}"]`)) commitEdit();
    if (isEditableTarget(event.target)) return;
    viewport.focus({ preventScroll: true });
    if (event.button === 1 || (event.button === 0 && spaceHeld)) {
      event.preventDefault();
      startPan(event);
      return;
    }
    if (event.button !== 0) return;
    const nodeElement = event.target.closest('[data-node-id]');
    if (nodeElement) {
      event.preventDefault();
      const nodeId = nodeElement.dataset.nodeId;
      if (event.altKey) startEdgeCreate(event, nodeId);
      else startNodeDrag(event, nodeId);
      return;
    }
    event.preventDefault();
    startBackgroundGesture(event);
  }

  function onPointerMove(event) {
    lastPointer = eventPoint(event);
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    const point = eventPoint(event);
    if (gesture.type === 'pan') {
      setCamera({
        x: gesture.camera.x + point.x - gesture.start.x,
        y: gesture.camera.y + point.y - gesture.start.y,
        scale: gesture.camera.scale,
      });
      return;
    }
    if (gesture.type === 'edge-create') {
      gesture.current = point;
      renderActiveEdges();
      return;
    }
    if (gesture.type === 'box') {
      gesture.current = point;
      if (!gesture.moved && Math.hypot(point.x - gesture.start.x, point.y - gesture.start.y) >= DRAG_THRESHOLD) {
        gesture.moved = true;
      }
      if (gesture.moved) updateFrame(gesture.start, point);
      return;
    }
    if (gesture.type === 'node-drag') {
      const dx = (point.x - gesture.start.x) / camera.scale;
      const dy = (point.y - gesture.start.y) / camera.scale;
      if (!gesture.moved && Math.hypot(point.x - gesture.start.x, point.y - gesture.start.y) >= DRAG_THRESHOLD) {
        gesture.moved = true;
      }
      if (!gesture.moved) return;
      const positions = {};
      Object.entries(gesture.positions).forEach(([nodeId, start]) => {
        positions[nodeId] = { x: start.x + dx, y: start.y + dy };
      });
      model.moveNodes(positions, { live: true });
      renderActiveEdges();
    }
  }

  function targetNodeAt(clientX, clientY) {
    const element = document.elementFromPoint(clientX, clientY);
    const nodeElement = element && element.closest && element.closest('[data-node-id]');
    return nodeElement ? nodeElement.dataset.nodeId : null;
  }

  function finishGesture(event, commit = true) {
    if (!gesture) return;
    const state = gesture;
    gesture = null;
    if (state.pointerId != null && viewport.hasPointerCapture(state.pointerId)) {
      viewport.releasePointerCapture(state.pointerId);
    }
    viewport.classList.remove('is-panning');
    nodeElements.forEach((element) => element.classList.remove('is-dragging'));
    selectionFrame.hidden = true;
    clearActiveEdges();
    if (state.type === 'node-drag' && state.moved) {
      if (commit) model.commitFrom(state.before, { kind: 'node-move', nodeIds: Object.keys(state.positions), alreadyEmitted: true });
      else model.restore(state.before, true);
      rebuildEdgeCache();
      redrawMinimap();
      scheduleDraw();
    } else if (state.type === 'edge-create' && commit && event) {
      const targetId = targetNodeAt(event.clientX, event.clientY);
      if (targetId && targetId !== state.fromId) model.createEdge(state.fromId, targetId);
    }
  }

  function onPointerUp(event) {
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    finishGesture(event, true);
  }

  function onDoubleClick(event) {
    const nodeElement = event.target.closest('[data-node-id]');
    if (nodeElement) {
      event.preventDefault();
      selectOnlyNode(nodeElement.dataset.nodeId);
      beginEdit(nodeElement.dataset.nodeId);
      return;
    }
    if (event.target === viewport || event.target === surface || event.target === edgesCanvas) {
      event.preventDefault();
      createNodeAt(screenToWorld(eventPoint(event)));
    }
  }

  function onWheel(event) {
    event.preventDefault();
    const point = eventPoint(event);
    const direction = event.deltaY > 0 ? -1 : 1;
    const factor = Math.exp(direction * Math.min(Math.abs(event.deltaY), 200) / 200 * Math.log(1.1));
    zoomAt(camera.scale * factor, point);
  }

  function createChild(node) {
    const child = createNodeAt({
      x: node.x + node.width + 92 + 84,
      y: node.y + node.height / 2,
    }, { edit: false, fromId: node.id });
    if (!child) return;
    beginEdit(child.id);
  }

  function createSibling(node) {
    const incoming = model.edges().find((edge) => edge.to === node.id);
    const sibling = createNodeAt({
      x: node.x + node.width / 2,
      y: node.y + node.height + 76 + 32,
    }, { edit: false, fromId: incoming ? incoming.from : null });
    if (!sibling) return;
    beginEdit(sibling.id);
  }

  function onKeyDown(event) {
    const modifier = event.ctrlKey || event.metaKey;
    if (editing) {
      if (event.key === 'Escape') {
        event.preventDefault();
        cancelEdit();
      } else if (modifier && event.key === 'Enter') {
        event.preventDefault();
        commitEdit();
      }
      return;
    }
    if (isEditableTarget(event.target)) return;
    if (modifier && (event.key === 'z' || event.key === 'Z')) {
      event.preventDefault();
      if (event.shiftKey) model.redo();
      else model.undo();
      return;
    }
    if (modifier && (event.key === 'y' || event.key === 'Y')) {
      event.preventDefault();
      model.redo();
      return;
    }
    if (modifier && (event.key === 'a' || event.key === 'A')) {
      event.preventDefault();
      selectedNodeIds.clear();
      model.nodes().forEach((node) => selectedNodeIds.add(node.id));
      selectedEdgeIds.clear();
      renderSelection();
      return;
    }
    if (modifier && event.key === '0') {
      event.preventDefault();
      resetZoom();
      return;
    }
    if (modifier && event.key === '1') {
      event.preventDefault();
      fitToContent();
      return;
    }
    if (event.code === 'Space' && !event.altKey && !modifier) {
      event.preventDefault();
      spaceHeld = true;
      viewport.classList.add('is-space-held');
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      if (gesture) finishGesture(null, false);
      else clearSelection();
      return;
    }
    if ((event.key === 'Delete' || event.key === 'Backspace')
      && (selectedNodeIds.size || selectedEdgeIds.size)) {
      event.preventDefault();
      model.remove(selectedNodeIds, selectedEdgeIds);
      clearSelection();
      return;
    }
    const onlyNode = selectedNodeIds.size === 1 && selectedEdgeIds.size === 0
      ? model.node([...selectedNodeIds][0]) : null;
    if (onlyNode && event.key === 'F2') {
      event.preventDefault();
      beginEdit(onlyNode.id);
      return;
    }
    if (onlyNode && event.key === 'Tab' && !event.altKey && !modifier) {
      event.preventDefault();
      createChild(onlyNode);
      return;
    }
    if (onlyNode && event.key === 'Enter' && !event.altKey && !modifier) {
      event.preventDefault();
      createSibling(onlyNode);
      return;
    }
    if (onlyNode && !event.altKey && !modifier && event.key.length === 1 && event.key !== ' ') {
      event.preventDefault();
      beginEdit(onlyNode.id, event.key);
      return;
    }
    if (!selectedNodeIds.size && !selectedEdgeIds.size && !event.altKey && !modifier
      && (event.key === 'n' || event.key === 'N')) {
      event.preventDefault();
      const rect = viewportRect();
      createNodeAt(screenToWorld(lastPointer || { x: rect.width / 2, y: rect.height / 2 }));
      return;
    }
    const step = 42;
    const panKeys = {
      ArrowLeft: [step, 0], ArrowRight: [-step, 0], ArrowUp: [0, step], ArrowDown: [0, -step],
    };
    const wasd = !onlyNode && event.key.length === 1
      ? { a: 'ArrowLeft', d: 'ArrowRight', w: 'ArrowUp', s: 'ArrowDown' }[event.key.toLowerCase()]
      : null;
    const pan = panKeys[wasd || event.key];
    if (pan && !event.altKey && !modifier) {
      event.preventDefault();
      setCamera({ x: camera.x + pan[0], y: camera.y + pan[1], scale: camera.scale });
    }
  }

  function onKeyUp(event) {
    if (event.code !== 'Space') return;
    spaceHeld = false;
    viewport.classList.remove('is-space-held');
  }

  function minimapBounds(nodes) {
    return nodes.reduce((result, node) => ({
      left: Math.min(result.left, node.x),
      top: Math.min(result.top, node.y),
      right: Math.max(result.right, node.x + node.width),
      bottom: Math.max(result.bottom, node.y + node.height),
    }), { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity });
  }

  function redrawMinimap() {
    const nodes = model.nodes();
    minimap.hidden = !nodes.length;
    minimapNodes.replaceChildren();
    if (!nodes.length) {
      minimapMapping = null;
      return;
    }
    const bounds = minimapBounds(nodes);
    const padding = 8;
    const width = 156;
    const height = 104;
    const scale = Math.min(
      (width - padding * 2) / Math.max(1, bounds.right - bounds.left),
      (height - padding * 2) / Math.max(1, bounds.bottom - bounds.top),
    );
    const drawWidth = (bounds.right - bounds.left) * scale;
    const drawHeight = (bounds.bottom - bounds.top) * scale;
    minimapMapping = {
      scale,
      left: bounds.left,
      top: bounds.top,
      offsetX: (width - drawWidth) / 2,
      offsetY: (height - drawHeight) / 2,
    };
    nodes.forEach((node) => {
      const dot = document.createElement('div');
      dot.className = 'research-minimap-node';
      dot.dataset.minimapNodeId = node.id;
      positionMinimapNode(dot, node);
      minimapNodes.appendChild(dot);
    });
    updateMinimapViewbox();
  }

  function positionMinimapNode(dot, node) {
    if (!minimapMapping || !dot || !node) return;
    dot.style.left = minimapMapping.offsetX + (node.x - minimapMapping.left) * minimapMapping.scale + 'px';
    dot.style.top = minimapMapping.offsetY + (node.y - minimapMapping.top) * minimapMapping.scale + 'px';
    dot.style.width = Math.max(2, node.width * minimapMapping.scale) + 'px';
    dot.style.height = Math.max(2, node.height * minimapMapping.scale) + 'px';
  }

  function updateMinimapNodes(nodeIds) {
    if (!minimapMapping) return;
    nodeIds.forEach((nodeId) => {
      const node = model.node(nodeId);
      const dot = minimapNodes.querySelector(`[data-minimap-node-id="${CSS.escape(nodeId)}"]`);
      if (node && dot) positionMinimapNode(dot, node);
    });
  }

  function updateMinimapViewbox() {
    if (!minimapMapping || minimap.hidden) return;
    const rect = viewportRect();
    const world = screenToWorld({ x: 0, y: 0 });
    minimapViewbox.style.left = minimapMapping.offsetX
      + (world.x - minimapMapping.left) * minimapMapping.scale + 'px';
    minimapViewbox.style.top = minimapMapping.offsetY
      + (world.y - minimapMapping.top) * minimapMapping.scale + 'px';
    minimapViewbox.style.width = Math.max(3, rect.width / camera.scale * minimapMapping.scale) + 'px';
    minimapViewbox.style.height = Math.max(3, rect.height / camera.scale * minimapMapping.scale) + 'px';
  }

  function onMinimapPointerDown(event) {
    if (!minimapMapping || event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const rect = minimap.getBoundingClientRect();
    const world = {
      x: minimapMapping.left + (event.clientX - rect.left - minimapMapping.offsetX) / minimapMapping.scale,
      y: minimapMapping.top + (event.clientY - rect.top - minimapMapping.offsetY) / minimapMapping.scale,
    };
    const view = viewportRect();
    setCamera({
      x: view.width / 2 - world.x * camera.scale,
      y: view.height / 2 - world.y * camera.scale,
      scale: camera.scale,
    });
  }

  function onModelChange(change) {
    if (change.topology) {
      syncNodeElements();
      rebuildEdgeCache();
      redrawMinimap();
      renderSelection();
      return;
    }
    const nodeIds = Array.isArray(change.nodeIds) ? change.nodeIds : [];
    nodeIds.forEach((nodeId) => {
      const node = model.node(nodeId);
      if (node) renderNode(node);
    });
    if (change.live && gesture && gesture.type === 'node-drag') {
      updateMinimapNodes(nodeIds);
      renderActiveEdges();
      return;
    }
    rebuildEdgeCache();
    redrawMinimap();
    scheduleDraw();
  }

  const unsubscribe = model.subscribe(onModelChange);
  syncNodeElements();
  rebuildEdgeCache();
  redrawMinimap();
  applyCamera();

  function activate() {
    if (disposed || active) return !disposed;
    active = true;
    activeController = new AbortController();
    const signal = activeController.signal;
    viewport.addEventListener('pointerdown', onPointerDown, { signal });
    viewport.addEventListener('pointermove', onPointerMove, { signal });
    viewport.addEventListener('pointerup', onPointerUp, { signal });
    viewport.addEventListener('pointercancel', onPointerUp, { signal });
    viewport.addEventListener('dblclick', onDoubleClick, { signal });
    viewport.addEventListener('wheel', onWheel, { passive: false, signal });
    minimap.addEventListener('pointerdown', onMinimapPointerDown, { signal });
    window.addEventListener('keydown', onKeyDown, { capture: true, signal });
    window.addEventListener('keyup', onKeyUp, { capture: true, signal });
    window.addEventListener('blur', () => {
      spaceHeld = false;
      viewport.classList.remove('is-space-held');
      if (gesture) finishGesture(null, true);
    }, { signal });
    resizeObserver = typeof ResizeObserver === 'function' ? new ResizeObserver(resizeCanvas) : null;
    if (resizeObserver) resizeObserver.observe(viewport);
    resizeCanvas();
    scheduleDraw();
    return true;
  }

  function suspend() {
    if (disposed) return true;
    if (editing) commitEdit();
    if (gesture) finishGesture(null, true);
    if (activeController) activeController.abort();
    activeController = null;
    if (resizeObserver) resizeObserver.disconnect();
    resizeObserver = null;
    if (drawRaf) cancelAnimationFrame(drawRaf);
    drawRaf = 0;
    active = false;
    spaceHeld = false;
    viewport.classList.remove('is-space-held', 'is-panning');
    return true;
  }

  function dispose() {
    if (disposed) return true;
    suspend();
    disposed = true;
    unsubscribe();
    nodeElements.clear();
    edgePathCache.clear();
    edgeSpatialGrid.clear();
    surface.replaceChildren();
    clearActiveEdges();
    context.clearRect(0, 0, edgesCanvas.width, edgesCanvas.height);
    return true;
  }

  return Object.freeze({ activate, suspend, dispose });
}

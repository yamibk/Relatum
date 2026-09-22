import { formatResearchValue } from './research-values.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const EDGE_GRID_SIZE = 512;
const MIN_SCALE = 0.18;
const MAX_SCALE = 3.5;
const CAMERA_EASE = 0.32;
const FRAME_MS = 1000 / 60;
const DRAG_THRESHOLD = 4;
const PROJECTION_NODES_PER_FRAME = 128;
const PROJECTION_FRAME_BUDGET_MS = 4;
const CONNECTION_KINDS = new Set(['relation', 'wire']);
const COORDINATES_VISIBLE_KEY = 'research:coordinatesVisible:v1';
const COORDINATE_LABELS_VISIBLE_KEY = 'research:coordinateLabelsVisible:v1';

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function frameRatio(ratio, frames) {
  return 1 - Math.pow(1 - ratio, frames);
}

function tickFrames(timestamp, previousTimestamp) {
  let frames = previousTimestamp ? (timestamp - previousTimestamp) / FRAME_MS : 1;
  if (!(frames > 0)) frames = 1;
  return clamp(frames, 0.35, 3);
}

export function researchCoordinateStep(scale, targetPixels = 80) {
  const safeScale = Math.max(0.0001, Math.abs(Number(scale)) || 1);
  const raw = Math.max(Number.MIN_VALUE, (Number(targetPixels) || 80) / safeScale);
  const power = Math.pow(10, Math.floor(Math.log10(raw)));
  const normalized = raw / power;
  const factor = normalized < Math.sqrt(2) ? 1
    : normalized < Math.sqrt(10) ? 2
      : normalized < Math.sqrt(50) ? 5 : 10;
  return factor * power;
}

export function formatResearchCoordinate(value, step) {
  const clean = Math.abs(value) < Math.abs(step) / 1000 ? 0 : value;
  if (clean !== 0 && (Math.abs(clean) >= 1e6 || Math.abs(clean) < 1e-4)) {
    return clean.toExponential(2).replace(/\.00e/, 'e').replace(/(\.\d)0e/, '$1e');
  }
  const decimals = Math.max(0, Math.min(6, -Math.floor(Math.log10(Math.abs(step) || 1))));
  return clean.toFixed(decimals).replace(/(\.\d*?[1-9])0+$/, '$1').replace(/\.0+$/, '');
}

function distanceToSegment(point, start, end) {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  if (!dx && !dy) return Math.hypot(point.x - start.x, point.y - start.y);
  const t = clamp(((point.x - start.x) * dx + (point.y - start.y) * dy) / (dx * dx + dy * dy), 0, 1);
  return Math.hypot(point.x - (start.x + dx * t), point.y - (start.y + dy * t));
}

export function researchRectBoundaryPoint(bounds, toward) {
  const left = Number(bounds && bounds.left);
  const top = Number(bounds && bounds.top);
  const right = Number(bounds && bounds.right);
  const bottom = Number(bounds && bounds.bottom);
  if (![left, top, right, bottom].every(Number.isFinite)) return { x: 0, y: 0 };
  const center = { x: (left + right) / 2, y: (top + bottom) / 2 };
  const dx = Number(toward && toward.x) - center.x;
  const dy = Number(toward && toward.y) - center.y;
  if (!Number.isFinite(dx) || !Number.isFinite(dy) || (!dx && !dy)) return center;
  const halfWidth = Math.max(0.5, (right - left) / 2);
  const halfHeight = Math.max(0.5, (bottom - top) / 2);
  const ratio = Math.max(Math.abs(dx) / halfWidth, Math.abs(dy) / halfHeight);
  return { x: center.x + dx / ratio, y: center.y + dy / ratio };
}

function isEditableTarget(target) {
  return !!(target && target.closest && target.closest('[contenteditable="true"], input, textarea, select'));
}

function twoDigits(value) {
  return String(Math.max(0, Math.floor(value))).padStart(2, '0');
}

function formatDuration(milliseconds) {
  const totalSeconds = Math.max(0, Math.round(Number(milliseconds) || 0) / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return twoDigits(hours) + ':' + twoDigits(minutes) + ':' + twoDigits(seconds);
}

function formatClock(timestamp) {
  const date = new Date(Number(timestamp));
  if (!Number.isFinite(date.getTime())) return '--:--:--';
  return twoDigits(date.getHours()) + ':' + twoDigits(date.getMinutes()) + ':' + twoDigits(date.getSeconds());
}

export function createResearchCanvas(options) {
  const stage = options.stage;
  let model = options.model;
  const registry = options.registry;
  const T = (source) => window.RelatumI18n ? window.RelatumI18n.t(source) : String(source || '');
  const onCreationToolChange = typeof options.onCreationToolChange === 'function'
    ? options.onCreationToolChange
    : null;
  const onViewChange = typeof options.onViewChange === 'function' ? options.onViewChange : null;
  const onSelectionChange = typeof options.onSelectionChange === 'function' ? options.onSelectionChange : null;
  const onNodeAction = typeof options.onNodeAction === 'function' ? options.onNodeAction : null;
  const viewport = stage && stage.querySelector('[data-research-viewport]');
  const surface = stage && stage.querySelector('[data-research-surface]');
  const edgesCanvas = stage && stage.querySelector('[data-research-edges]');
  const activeSvg = stage && stage.querySelector('[data-research-active-edges]');
  const selectionFrame = stage && stage.querySelector('[data-research-selection-frame]');
  const minimap = stage && stage.querySelector('[data-research-minimap]');
  const minimapNodes = stage && stage.querySelector('[data-research-minimap-nodes]');
  const minimapViewbox = stage && stage.querySelector('[data-research-minimap-viewbox]');
  const zoomIndicator = stage && stage.querySelector('[data-research-zoom-indicator]');
  const panSpeedInput = options.panSpeedInput || null;
  const panInertiaInput = options.panInertiaInput || null;
  const zoomSpeedInput = options.zoomSpeedInput || null;
  const coordinatesVisibleInput = options.coordinatesVisibleInput || null;
  const coordinateLabelsVisibleInput = options.coordinateLabelsVisibleInput || null;
  const panSpeedValue = options.panSpeedValue || null;
  const panInertiaValue = options.panInertiaValue || null;
  const zoomSpeedValue = options.zoomSpeedValue || null;

  if (!viewport || !surface || !edgesCanvas || !activeSvg || !selectionFrame
    || !minimap || !minimapNodes || !minimapViewbox || !zoomIndicator || !model || !registry) {
    throw new Error('研究画布 DOM 不完整');
  }

  const context = edgesCanvas.getContext('2d');
  const nodeElements = new Map();
  const nodeLayoutCache = new Map();
  const minimapNodeElements = new Map();
  const edgePathCache = new Map();
  const edgeSpatialGrid = new Map();
  const removalGhosts = new Set();
  const selectedNodeIds = new Set();
  const selectedEdgeIds = new Set();
  const initialView = options.view && typeof options.view === 'object' ? options.view : {};
  let camera = {
    x: Number.isFinite(Number(initialView.x)) ? Number(initialView.x) : 0,
    y: Number.isFinite(Number(initialView.y)) ? Number(initialView.y) : 0,
    scale: clamp(Number.isFinite(Number(initialView.scale)) ? Number(initialView.scale) : 1, MIN_SCALE, MAX_SCALE),
  };
  let targetCamera = { ...camera };
  let cameraRaf = 0;
  let cameraTickTimestamp = 0;
  let panInertiaRaf = 0;
  let panVelocity = null;
  let arrowPanRaf = 0;
  let arrowTickTimestamp = 0;
  const pressedPanKeys = new Set();
  let panSpeed = 8;
  let panInertia = 0.15;
  let zoomSpeed = 1;
  let coordinatesVisible = false;
  let coordinateLabelsVisible = false;
  let minimapMapping = null;
  let minimapNodeMapping = null;
  let minimapViewboxRect = null;
  let minimapRebaseTimer = 0;
  let minimapSize = { width: 180, height: 120 };
  let contentBoundsCache = null;
  let active = false;
  let disposed = false;
  let activeController = null;
  let viewportResizeObserver = null;
  let minimapResizeObserver = null;
  let nodeResizeObserver = null;
  let unsubscribe = null;
  let drawRaf = 0;
  let gesture = null;
  let editing = null;
  let spaceHeld = false;
  let lastPointer = null;
  let computeProjection = {};
  let projectionRaf = 0;
  let projectionNodeIds = [];
  let projectionCursor = 0;
  let pendingCreation = { type: 'note' };
  let connectionKind = 'wire';
  let altHeld = false;
  const primaryPresses = [];

  try {
    const storedPanSpeed = Number.parseInt(localStorage.getItem('research:panSpeed:v1'), 10);
    if (Number.isFinite(storedPanSpeed) && storedPanSpeed >= 1 && storedPanSpeed <= 20) panSpeed = storedPanSpeed;
    const storedPanInertia = Number.parseFloat(localStorage.getItem('research:panInertia:v1'));
    if (Number.isFinite(storedPanInertia) && storedPanInertia >= 0 && storedPanInertia <= 1) panInertia = storedPanInertia;
    const storedZoomSpeed = Number.parseFloat(localStorage.getItem('research:zoomSpeed:v1'));
    if (Number.isFinite(storedZoomSpeed) && storedZoomSpeed >= 0.5 && storedZoomSpeed <= 3) zoomSpeed = storedZoomSpeed;
    coordinatesVisible = localStorage.getItem(COORDINATES_VISIBLE_KEY) === '1';
    coordinateLabelsVisible = localStorage.getItem(COORDINATE_LABELS_VISIBLE_KEY) === '1';
  } catch (_error) {}
  viewport.dataset.researchCreationTool = pendingCreation.type;
  viewport.dataset.researchConnectionKind = connectionKind;

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

  function nodeVisualBounds(node) {
    const layout = node && nodeLayoutCache.get(node.id);
    const width = layout && layout.width || node && node.width || 0;
    const height = layout && layout.height || node && node.height || 0;
    return {
      left: node.x,
      top: node.y,
      right: node.x + width,
      bottom: node.y + height,
    };
  }

  function nodeCenter(node) {
    const bounds = nodeVisualBounds(node);
    return { x: (bounds.left + bounds.right) / 2, y: (bounds.top + bounds.bottom) / 2 };
  }

  function measureNodeLayout(nodeId) {
    const node = model.node(nodeId);
    const element = nodeElements.get(nodeId);
    if (!node || !element || !element.isConnected) return false;
    const width = element.offsetWidth || node.width;
    const height = element.offsetHeight || node.height;
    const elementRect = element.getBoundingClientRect();
    const scale = Math.max(0.0001, camera.scale);
    const ports = new Map();
    element.querySelectorAll('[data-research-port]').forEach((handle) => {
      const direction = handle.dataset.researchPortDirection;
      const portId = handle.dataset.researchPort;
      const handleRect = handle.getBoundingClientRect();
      const x = (handleRect.left + handleRect.width / 2 - elementRect.left) / scale;
      const y = (handleRect.top + handleRect.height / 2 - elementRect.top) / scale;
      ports.set(direction + '\n' + portId, { x, y });
    });
    const previous = nodeLayoutCache.get(nodeId);
    const signature = Array.from(ports, ([key, point]) => `${key}:${point.x}:${point.y}`).join('|');
    if (previous && previous.width === width && previous.height === height && previous.signature === signature) return false;
    nodeLayoutCache.set(nodeId, { width, height, ports, signature });
    return true;
  }

  function portWorldPoint(node, port, direction) {
    if (!node) return { x: 0, y: 0 };
    const layout = nodeLayoutCache.get(node.id);
    const measured = layout && layout.ports.get(direction + '\n' + port);
    if (measured) return { x: node.x + measured.x, y: node.y + measured.y };
    const definition = registry.definition(node.type);
    if (!definition) return nodeCenter(node);
    const ports = registry.portsFor(node).filter((item) => item.direction === direction);
    const index = Math.max(0, ports.findIndex((item) => item.id === port));
    const bounds = nodeVisualBounds(node);
    return {
      x: direction === 'input' ? bounds.left : bounds.right,
      y: bounds.top + (bounds.bottom - bounds.top) * ((index + 1) / (ports.length + 1)),
    };
  }

  function applyCamera() {
    surface.style.transform = `translate(${camera.x}px, ${camera.y}px) scale(${camera.scale})`;
    const zoomText = Math.round(camera.scale * 100) + '%';
    if (zoomIndicator.textContent !== zoomText) zoomIndicator.textContent = zoomText;
    scheduleDraw();
    renderActiveEdges();
    updateMinimapViewport();
  }

  function notifyViewChange() {
    if (onViewChange) onViewChange({ ...targetCamera });
  }

  function cancelCameraAnimation() {
    if (cameraRaf) cancelAnimationFrame(cameraRaf);
    cameraRaf = 0;
    cameraTickTimestamp = 0;
  }

  function cancelPanInertia() {
    if (panInertiaRaf) cancelAnimationFrame(panInertiaRaf);
    panInertiaRaf = 0;
    panVelocity = null;
  }

  function setCamera(next, options = {}) {
    const changed = {
      x: Number.isFinite(next.x) ? next.x : camera.x,
      y: Number.isFinite(next.y) ? next.y : camera.y,
      scale: clamp(Number.isFinite(next.scale) ? next.scale : camera.scale, MIN_SCALE, MAX_SCALE),
    };
    if (!options.preserveInertia) cancelPanInertia();
    cancelCameraAnimation();
    targetCamera = { ...changed };
    if (changed.x === camera.x && changed.y === camera.y && changed.scale === camera.scale) return false;
    camera = changed;
    applyCamera();
    notifyViewChange();
    return true;
  }

  function freezeCameraForInteraction() {
    if (!cameraRaf) return;
    cancelCameraAnimation();
    targetCamera = { ...camera };
    applyCamera();
    notifyViewChange();
  }

  function tickCamera(timestamp) {
    cameraRaf = 0;
    const scaleDistance = targetCamera.scale - camera.scale;
    const xDistance = targetCamera.x - camera.x;
    const yDistance = targetCamera.y - camera.y;
    if (Math.abs(scaleDistance) < .0008 && Math.abs(xDistance) < .4 && Math.abs(yDistance) < .4) {
      camera = { ...targetCamera };
      cameraTickTimestamp = 0;
      applyCamera();
      return;
    }
    const ratio = frameRatio(CAMERA_EASE, tickFrames(timestamp, cameraTickTimestamp));
    cameraTickTimestamp = timestamp;
    camera = {
      x: camera.x + xDistance * ratio,
      y: camera.y + yDistance * ratio,
      scale: camera.scale + scaleDistance * ratio,
    };
    applyCamera();
    cameraRaf = requestAnimationFrame(tickCamera);
  }

  function animateCamera(next) {
    const changed = {
      x: Number.isFinite(next.x) ? next.x : targetCamera.x,
      y: Number.isFinite(next.y) ? next.y : targetCamera.y,
      scale: clamp(Number.isFinite(next.scale) ? next.scale : targetCamera.scale, MIN_SCALE, MAX_SCALE),
    };
    cancelPanInertia();
    targetCamera = changed;
    notifyViewChange();
    if (reducedMotionPreferred()) {
      cancelCameraAnimation();
      camera = { ...targetCamera };
      applyCamera();
      return;
    }
    if (!cameraRaf) cameraRaf = requestAnimationFrame(tickCamera);
  }

  function zoomAt(nextScale, screenPoint) {
    const scale = clamp(nextScale, MIN_SCALE, MAX_SCALE);
    const world = {
      x: (screenPoint.x - targetCamera.x) / targetCamera.scale,
      y: (screenPoint.y - targetCamera.y) / targetCamera.scale,
    };
    animateCamera({
      x: screenPoint.x - world.x * scale,
      y: screenPoint.y - world.y * scale,
      scale,
    });
  }

  function resetZoom() {
    const rect = viewportRect();
    zoomAt(1, { x: rect.width / 2, y: rect.height / 2 });
  }

  function centerOrigin() {
    const rect = viewportRect();
    animateCamera({ x: rect.width / 2, y: rect.height / 2, scale: targetCamera.scale });
    return true;
  }

  function fitToContent() {
    const nodes = model.nodes();
    if (!nodes.length) {
      animateCamera({ x: 0, y: 0, scale: 1 });
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
    animateCamera({
      x: rect.width / 2 - ((bounds.left + bounds.right) / 2) * scale,
      y: rect.height / 2 - ((bounds.top + bounds.bottom) / 2) * scale,
      scale,
    });
  }

  function focusNodes(nodeIds, options = {}) {
    const ids = new Set(Array.from(nodeIds || [], String));
    const nodes = model.nodes().filter((node) => ids.has(node.id));
    if (!nodes.length) return false;
    const bounds = nodes.reduce((result, node) => ({
      left: Math.min(result.left, node.x),
      top: Math.min(result.top, node.y),
      right: Math.max(result.right, node.x + node.width),
      bottom: Math.max(result.bottom, node.y + node.height),
    }), { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity });
    const rect = viewportRect();
    const viewportBounds = viewport.getBoundingClientRect();
    const frame = { left: 0, top: 0, right: rect.width, bottom: rect.height };
    const occluders = [
      stage.querySelector('[data-research-side-panel]'),
      stage.querySelector('[data-research-compute-dock]'),
    ].filter((element) => element && !element.hidden && getComputedStyle(element).visibility !== 'hidden');
    occluders.forEach((element) => {
      const occupied = element.getBoundingClientRect();
      const horizontalOverlap = occupied.right > viewportBounds.left && occupied.left < viewportBounds.right;
      const verticalOverlap = occupied.bottom > viewportBounds.top && occupied.top < viewportBounds.bottom;
      if (!horizontalOverlap || !verticalOverlap) return;
      if (occupied.top >= viewportBounds.top + rect.height * .55) {
        frame.bottom = Math.min(frame.bottom, occupied.top - viewportBounds.top - 18);
      } else if (occupied.left <= viewportBounds.left + rect.width * .35) {
        frame.left = Math.max(frame.left, occupied.right - viewportBounds.left + 18);
      } else if (occupied.right >= viewportBounds.right - rect.width * .35) {
        frame.right = Math.min(frame.right, occupied.left - viewportBounds.left - 18);
      }
    });
    if (frame.right - frame.left < 180 || frame.bottom - frame.top < 160) {
      frame.left = 0; frame.top = 0; frame.right = rect.width; frame.bottom = rect.height;
    }
    const padding = Math.max(24, Number(options.padding) || 72);
    const scale = clamp(Math.min(
      Math.max(1, frame.right - frame.left - padding * 2) / Math.max(1, bounds.right - bounds.left),
      Math.max(1, frame.bottom - frame.top - padding * 2) / Math.max(1, bounds.bottom - bounds.top),
    ), MIN_SCALE, 1.25);
    const next = {
      x: (frame.left + frame.right) / 2 - ((bounds.left + bounds.right) / 2) * scale,
      y: (frame.top + frame.bottom) / 2 - ((bounds.top + bounds.bottom) / 2) * scale,
      scale,
    };
    if (options.immediate || reducedMotionPreferred()) setCamera(next);
    else animateCamera(next);
    return true;
  }

  function startPanInertia(state) {
    cancelPanInertia();
    if (!state || state.velocityX == null || !(panInertia > 0) || reducedMotionPreferred()) return;
    const now = performance.now();
    if (state.lastMoveTimestamp == null || now - state.lastMoveTimestamp > 60) return;
    let velocityX = state.velocityX * panInertia;
    let velocityY = state.velocityY * panInertia;
    const speed = Math.hypot(velocityX, velocityY);
    if (speed < .06) return;
    if (speed > 5) {
      const ratio = 5 / speed;
      velocityX *= ratio;
      velocityY *= ratio;
    }
    panVelocity = { x: velocityX, y: velocityY };
    let previous = now;
    const step = (timestamp) => {
      panInertiaRaf = 0;
      if (!active || reducedMotionPreferred()) { panVelocity = null; return; }
      let elapsed = timestamp - previous;
      previous = timestamp;
      if (!(elapsed > 0)) elapsed = 16.7;
      elapsed = Math.min(40, elapsed);
      const friction = Math.exp(-.0045 * elapsed);
      setCamera({
        x: camera.x + panVelocity.x * elapsed,
        y: camera.y + panVelocity.y * elapsed,
        scale: camera.scale,
      }, { preserveInertia: true });
      panVelocity.x *= friction;
      panVelocity.y *= friction;
      if (Math.hypot(panVelocity.x, panVelocity.y) > .015) {
        panInertiaRaf = requestAnimationFrame(step);
      } else panVelocity = null;
    };
    panInertiaRaf = requestAnimationFrame(step);
  }

  function stopArrowPan() {
    if (arrowPanRaf) cancelAnimationFrame(arrowPanRaf);
    arrowPanRaf = 0;
    arrowTickTimestamp = 0;
    pressedPanKeys.clear();
  }

  function startArrowPan() {
    if (arrowPanRaf) return;
    cancelPanInertia();
    freezeCameraForInteraction();
    const tick = (timestamp) => {
      arrowPanRaf = 0;
      let x = 0;
      let y = 0;
      if (pressedPanKeys.has('ArrowLeft')) x += panSpeed;
      if (pressedPanKeys.has('ArrowRight')) x -= panSpeed;
      if (pressedPanKeys.has('ArrowUp')) y += panSpeed;
      if (pressedPanKeys.has('ArrowDown')) y -= panSpeed;
      if (!x && !y) { arrowTickTimestamp = 0; return; }
      const frames = tickFrames(timestamp, arrowTickTimestamp);
      arrowTickTimestamp = timestamp;
      setCamera({ x: camera.x + x * frames, y: camera.y + y * frames, scale: camera.scale });
      arrowPanRaf = requestAnimationFrame(tick);
    };
    arrowPanRaf = requestAnimationFrame(tick);
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
    updateMinimapViewport();
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
    text.dataset.userContent = '';
    element.appendChild(text);
    const result = document.createElement('div');
    result.className = 'research-node-result';
    result.dataset.computeResult = '';
    result.hidden = true;
    element.appendChild(result);
    const action = document.createElement('button');
    action.type = 'button';
    action.className = 'research-node-action';
    action.dataset.nodeAction = '';
    action.hidden = true;
    element.appendChild(action);
    surface.appendChild(element);
    nodeElements.set(node.id, element);
    if (nodeResizeObserver) nodeResizeObserver.observe(element);
    renderNode(node);
    return element;
  }

  function syncComputeDecorations(element, node) {
    const definition = registry.definition(node.type);
    const executable = !!definition && node.type !== 'note';
    element.classList.toggle('is-compute', executable);
    element.dataset.computeKind = node.type;
    element.dataset.nodeType = node.type;
    let badge = element.querySelector('[data-compute-badge]');
    let ports = element.querySelector('[data-compute-ports]');
    if (!executable) {
      if (badge) badge.remove();
      if (ports) ports.remove();
      const result = element.querySelector('[data-compute-result]');
      if (result) result.hidden = true;
      element.classList.remove('is-compute-error', 'has-compute-output');
      return;
    }
    if (!badge) {
      badge = document.createElement('span');
      badge.className = 'research-node-compute-badge';
      badge.dataset.computeBadge = '';
      element.prepend(badge);
    }
    badge.textContent = definition.label || node.type;
    const dynamicPorts = registry.portsFor(node);
    const inputPorts = dynamicPorts.filter((port) => port.direction === 'input');
    const outputPorts = dynamicPorts.filter((port) => port.direction === 'output');
    const signature = dynamicPorts.map((port) => `${port.direction}:${port.channel}:${port.id}`).join('|');
    if (!ports) {
      ports = document.createElement('div');
      ports.className = 'research-node-ports';
      ports.dataset.computePorts = '';
      element.appendChild(ports);
    }
    if (ports.dataset.portSignature !== signature) {
      ports.dataset.portSignature = signature;
      ports.replaceChildren();
      if (definition) {
        inputPorts.forEach((port, index) => {
          const handle = document.createElement('span');
          handle.className = 'research-port is-input is-' + port.channel;
          handle.dataset.researchPort = port.id;
          handle.dataset.researchPortChannel = port.channel;
          handle.dataset.researchPortDirection = 'input';
          handle.dataset.portLabel = `${port.id} · ${port.channel === 'event' ? 'Pulse' : port.types.join('/')}`;
          handle.setAttribute('aria-label', `输入端口 ${port.id} · ${port.channel}`);
          handle.title = `${port.id} · ${port.channel === 'event' ? '事件' : port.types.join('/')}`;
          handle.style.top = ((index + 1) / (inputPorts.length + 1) * 100) + '%';
          ports.appendChild(handle);
        });
        outputPorts.forEach((port, index) => {
          const handle = document.createElement('span');
          handle.className = 'research-port is-output is-' + port.channel;
          handle.dataset.researchPort = port.id;
          handle.dataset.researchPortChannel = port.channel;
          handle.dataset.researchPortDirection = 'output';
          handle.dataset.portLabel = `${port.id} · ${port.channel === 'event' ? 'Pulse' : port.types.join('/')}`;
          handle.setAttribute('aria-label', `输出端口 ${port.id} · ${port.channel}`);
          handle.title = `${port.id} · ${port.channel === 'event' ? '事件' : port.types.join('/')}`;
          handle.style.top = ((index + 1) / (outputPorts.length + 1) * 100) + '%';
          ports.appendChild(handle);
        });
      }
    }
    const projection = computeProjection[node.id] || null;
    const result = element.querySelector('[data-compute-result]');
    const output = projection && projection.output;
    const trace = projection && Array.isArray(projection.trace) ? projection.trace : [];
    result.hidden = !projection || (node.type !== 'probe' && !output && !projection.error && !projection.lastPulse);
    element.classList.toggle('is-compute-error', !!(projection && projection.error));
    element.classList.toggle('has-compute-output', !!output);
    if (!result.hidden) {
      if (projection.error) result.textContent = '错误 · ' + projection.error.message;
      else if (node.type === 'probe') {
        const latest = trace[trace.length - 1];
        if (!latest) result.textContent = '轨迹 · 0/' + (projection.traceLimit || node.config.historyLimit || 64);
        else if (latest.kind === 'event') result.textContent = `Pulse #${latest.sequence} · t=${latest.simulationTime}ms`;
        else result.textContent = `= ${formatResearchValue(latest.value)} · t=${latest.simulationTime}ms`;
      }
      else if (!output && projection.lastPulse) result.textContent = 'Pulse · #' + projection.lastPulse.sequence;
      else if (node.type === 'timer' && output.type === 'number') result.textContent = '= ' + formatDuration(output.value);
      else result.textContent = '= ' + formatResearchValue(output);
      if (node.type === 'timer' && projection.outputs && projection.outputs.running) {
        result.textContent += projection.outputs.running.value ? ' · 运行中' : ' · 已暂停';
      }
    }
    const action = element.querySelector('[data-node-action]');
    if (action) {
      action.hidden = !definition.interactive;
      action.textContent = node.type === 'button' ? '触发' : '切换';
      action.setAttribute('aria-label', node.type === 'button' ? '触发按钮' : '切换开关');
    }
    element.classList.toggle('is-lamp-on', node.type === 'lamp' && output
      && (output.type === 'boolean' ? output.value : output.type === 'bits' && output.value !== '0x0'));
  }

  function renderNode(node) {
    let element = nodeElements.get(node.id);
    if (!element) element = createNodeElement(node);
    const definition = registry.definition(node.type);
    const usesDefaultLabel = !!(definition && node.label === definition.defaultLabel);
    element.style.transform = `translate(${node.x}px, ${node.y}px)`;
    element.style.width = node.width + 'px';
    element.style.minHeight = node.height + 'px';
    element.classList.toggle('is-selected', selectedNodeIds.has(node.id));
    element.setAttribute('aria-label', node.label || '节点');
    const text = element.querySelector('[data-node-text]');
    text.toggleAttribute('data-user-content', !usesDefaultLabel);
    if (!editing || editing.nodeId !== node.id) text.textContent = node.label;
    syncComputeDecorations(element, node);
    if (!nodeLayoutCache.has(node.id)) measureNodeLayout(node.id);
  }

  function syncNodeElements() {
    const nodes = model.nodes();
    const liveIds = new Set(nodes.map((node) => node.id));
    nodeElements.forEach((element, nodeId) => {
      if (liveIds.has(nodeId)) return;
      if (nodeResizeObserver) nodeResizeObserver.unobserve(element);
      element.remove();
      nodeElements.delete(nodeId);
      nodeLayoutCache.delete(nodeId);
      selectedNodeIds.delete(nodeId);
    });
    nodes.forEach(renderNode);
    selectedEdgeIds.forEach((edgeId) => {
      if (!model.edge(edgeId)) selectedEdgeIds.delete(edgeId);
    });
  }

  function edgeGeometry(edge) {
    const wire = edge.kind === 'wire';
    const from = model.node(wire ? edge.from.nodeId : edge.fromNodeId);
    const to = model.node(wire ? edge.to.nodeId : edge.toNodeId);
    if (!from || !to) return null;
    const fromCenter = nodeCenter(from);
    const toCenter = nodeCenter(to);
    const start = wire ? portWorldPoint(from, edge.from.portId, 'output')
      : researchRectBoundaryPoint(nodeVisualBounds(from), toCenter);
    const end = wire ? portWorldPoint(to, edge.to.portId, 'input')
      : researchRectBoundaryPoint(nodeVisualBounds(to), fromCenter);
    return {
      id: edge.id,
      kind: edge.kind,
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
    geometry.gridKeys = [];
    for (let y = minY; y <= maxY; y += 1) {
      for (let x = minX; x <= maxX; x += 1) {
        const key = gridKey(x, y);
        if (!edgeSpatialGrid.has(key)) edgeSpatialGrid.set(key, new Set());
        edgeSpatialGrid.get(key).add(geometry.id);
        geometry.gridKeys.push(key);
      }
    }
  }

  function removeEdgeFromGrid(geometry) {
    (geometry && geometry.gridKeys || []).forEach((key) => {
      const bucket = edgeSpatialGrid.get(key);
      if (!bucket) return;
      bucket.delete(geometry.id);
      if (!bucket.size) edgeSpatialGrid.delete(key);
    });
  }

  function refreshEdgeCache(edgeIds) {
    edgeIds.forEach((edgeId) => {
      const previous = edgePathCache.get(edgeId);
      if (previous) removeEdgeFromGrid(previous);
      edgePathCache.delete(edgeId);
      const edge = model.edge(edgeId);
      const geometry = edge && edgeGeometry(edge);
      if (!geometry) return;
      edgePathCache.set(edgeId, geometry);
      addEdgeToGrid(geometry);
    });
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
    drawCoordinatePlane(rect);
    const topLeft = screenToWorld({ x: 0, y: 0 });
    const bottomRight = screenToWorld({ x: rect.width, y: rect.height });
    const candidates = edgeIdsInBounds({
      left: Math.min(topLeft.x, bottomRight.x),
      top: Math.min(topLeft.y, bottomRight.y),
      right: Math.max(topLeft.x, bottomRight.x),
      bottom: Math.max(topLeft.y, bottomRight.y),
    });
    const movingEdges = gesture && gesture.type === 'node-drag' && gesture.moved
      ? gesture.edgeIds
      : gesture && gesture.type === 'data-edge-create' && gesture.rewireEdgeId
        ? new Set([gesture.rewireEdgeId]) : null;
    const rootStyle = getComputedStyle(document.documentElement);
    const selectedStroke = rootStyle.getPropertyValue('--research-selection').trim() || '#11120f';
    const regularStroke = rootStyle.getPropertyValue('--research-line').trim() || 'rgba(37,39,36,.62)';
    const dataStroke = rootStyle.getPropertyValue('--research-data-line').trim() || '#456553';
    candidates.forEach((edgeId) => {
      if (movingEdges && movingEdges.has(edgeId)) return;
      const geometry = edgePathCache.get(edgeId);
      if (!geometry) return;
      const start = worldToScreen(geometry.start);
      const end = worldToScreen(geometry.end);
      context.beginPath();
      context.moveTo(start.x, start.y);
      context.lineTo(end.x, end.y);
      context.lineWidth = selectedEdgeIds.has(edgeId) ? 2.4 : geometry.kind === 'wire' ? 1.8 : 1.35;
      context.strokeStyle = selectedEdgeIds.has(edgeId) ? selectedStroke
        : geometry.kind === 'wire' ? dataStroke : regularStroke;
      context.stroke();
    });
  }

  function drawCoordinatePlane(rect) {
    if (!coordinatesVisible || !(rect.width > 0) || !(rect.height > 0)) return;
    const step = researchCoordinateStep(camera.scale);
    const topLeft = screenToWorld({ x: 0, y: 0 });
    const bottomRight = screenToWorld({ x: rect.width, y: rect.height });
    const minX = Math.min(topLeft.x, bottomRight.x);
    const maxX = Math.max(topLeft.x, bottomRight.x);
    const minY = Math.min(topLeft.y, bottomRight.y);
    const maxY = Math.max(topLeft.y, bottomRight.y);
    const firstX = Math.ceil(minX / step) * step;
    const firstY = Math.ceil(minY / step) * step;
    const rootStyle = getComputedStyle(document.documentElement);
    const gridStroke = rootStyle.getPropertyValue('--research-grid-line').trim() || 'rgba(24,24,24,.09)';
    const axisStroke = rootStyle.getPropertyValue('--research-axis-line').trim() || 'rgba(24,24,24,.48)';
    const labelFill = rootStyle.getPropertyValue('--research-axis-label').trim() || 'rgba(24,24,24,.68)';

    context.save();
    context.lineWidth = 1;
    context.strokeStyle = gridStroke;
    context.beginPath();
    for (let x = firstX; x <= maxX + step * 0.001; x += step) {
      const screenX = Math.round(worldToScreen({ x, y: 0 }).x) + 0.5;
      context.moveTo(screenX, 0);
      context.lineTo(screenX, rect.height);
    }
    for (let y = firstY; y <= maxY + step * 0.001; y += step) {
      const screenY = Math.round(worldToScreen({ x: 0, y }).y) + 0.5;
      context.moveTo(0, screenY);
      context.lineTo(rect.width, screenY);
    }
    context.stroke();

    const origin = worldToScreen({ x: 0, y: 0 });
    context.strokeStyle = axisStroke;
    context.lineWidth = 1.35;
    context.beginPath();
    if (origin.y >= 0 && origin.y <= rect.height) {
      const y = Math.round(origin.y) + 0.5;
      context.moveTo(0, y); context.lineTo(rect.width, y);
    }
    if (origin.x >= 0 && origin.x <= rect.width) {
      const x = Math.round(origin.x) + 0.5;
      context.moveTo(x, 0); context.lineTo(x, rect.height);
    }
    context.stroke();

    if (coordinateLabelsVisible) {
      context.fillStyle = labelFill;
      context.font = '11px ui-monospace, "Cascadia Mono", Consolas, monospace';
      context.textBaseline = 'top';
      if (origin.y >= 0 && origin.y <= rect.height) {
        const labelY = origin.y > rect.height - 20 ? origin.y - 16 : origin.y + 4;
        context.textAlign = 'center';
        for (let x = firstX; x <= maxX + step * 0.001; x += step) {
          if (Math.abs(x) < step / 1000) continue;
          const screenX = worldToScreen({ x, y: 0 }).x;
          if (screenX < 18 || screenX > rect.width - 18) continue;
          context.fillText(formatResearchCoordinate(x, step), screenX, labelY);
        }
        context.textAlign = 'right';
        context.fillText('x', rect.width - 6, Math.max(2, labelY));
      }
      if (origin.x >= 0 && origin.x <= rect.width) {
        const labelX = origin.x < 42 ? origin.x + 34 : origin.x - 5;
        context.textAlign = 'right';
        context.textBaseline = 'middle';
        for (let y = firstY; y <= maxY + step * 0.001; y += step) {
          if (Math.abs(y) < step / 1000) continue;
          const screenY = worldToScreen({ x: 0, y }).y;
          if (screenY < 12 || screenY > rect.height - 12) continue;
          context.fillText(formatResearchCoordinate(-y, step), labelX, screenY);
        }
        context.textAlign = 'left';
        context.textBaseline = 'top';
        context.fillText('y', Math.min(rect.width - 12, origin.x + 5), 5);
      }
      if (origin.x >= 0 && origin.x <= rect.width && origin.y >= 0 && origin.y <= rect.height) {
        context.textAlign = 'left';
        context.textBaseline = 'top';
        context.fillText('0', origin.x + 5, origin.y + 5);
      }
    }
    context.restore();
  }

  function drawEdgesImmediately() {
    if (!active) return;
    if (drawRaf) cancelAnimationFrame(drawRaf);
    drawRaf = 0;
    drawEdges();
  }

  function clearActiveEdges() {
    activeSvg.replaceChildren();
  }

  function appendActiveLine(start, end, preview, dataLine = false, invalid = false) {
    const line = document.createElementNS(SVG_NS, 'line');
    line.setAttribute('x1', String(start.x));
    line.setAttribute('y1', String(start.y));
    line.setAttribute('x2', String(end.x));
    line.setAttribute('y2', String(end.y));
    if (preview) line.classList.add('is-preview');
    if (dataLine) line.classList.add('is-data');
    if (invalid) line.classList.add('is-invalid');
    activeSvg.appendChild(line);
    return line;
  }

  function reducedMotionPreferred() {
    return typeof window.matchMedia === 'function'
      && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  }

  function clearRemovalGhosts() {
    removalGhosts.forEach((ghost) => {
      if (ghost.getAnimations) ghost.getAnimations().forEach((animation) => animation.cancel());
      ghost.remove();
    });
    removalGhosts.clear();
  }

  function animateRemoval(nodeIds, edgeIds) {
    if (reducedMotionPreferred()) return;
    nodeIds.forEach((nodeId) => {
      const element = nodeElements.get(nodeId);
      if (!element || typeof element.animate !== 'function' || !element.isConnected) return;
      const ghost = element.cloneNode(true);
      ghost.classList.remove('is-selected', 'is-dragging', 'is-editing');
      ghost.classList.add('is-removal-ghost');
      ghost.setAttribute('aria-hidden', 'true');
      ghost.style.pointerEvents = 'none';
      surface.appendChild(ghost);
      removalGhosts.add(ghost);
      ghost.animate(
        [{ transform: 'scale(1)' }, { transform: 'scale(0.86)' }],
        { duration: 190, easing: 'cubic-bezier(0.4, 0, 1, 1)', composite: 'add' },
      );
      const fade = ghost.animate(
        [{ opacity: 1 }, { opacity: 0 }],
        { duration: 190, easing: 'cubic-bezier(0.4, 0, 1, 1)' },
      );
      const done = () => {
        ghost.remove();
        removalGhosts.delete(ghost);
      };
      fade.onfinish = done;
      fade.oncancel = done;
    });
    edgeIds.forEach((edgeId) => {
      const geometry = edgePathCache.get(edgeId);
      if (!geometry) return;
      const line = appendActiveLine(
        worldToScreen(geometry.start),
        worldToScreen(geometry.end),
        false,
        geometry.kind === 'wire',
      );
      line.classList.add('is-removal-ghost');
      removalGhosts.add(line);
      if (typeof line.animate !== 'function') {
        line.remove();
        removalGhosts.delete(line);
        return;
      }
      const fade = line.animate(
        [{ opacity: 1 }, { opacity: 0 }],
        { duration: 190, easing: 'cubic-bezier(0.4, 0, 1, 1)' },
      );
      const done = () => {
        line.remove();
        removalGhosts.delete(line);
      };
      fade.onfinish = done;
      fade.oncancel = done;
    });
  }

  function renderActiveEdges() {
    clearActiveEdges();
    if (!gesture) return;
    if (gesture.type === 'node-drag' && gesture.moved) {
      gesture.edgeIds.forEach((edgeId) => {
        const edge = model.edge(edgeId);
        const geometry = edge && edgeGeometry(edge);
        if (geometry) appendActiveLine(worldToScreen(geometry.start), worldToScreen(geometry.end), false, geometry.kind === 'wire');
      });
    } else if (gesture.type === 'edge-create') {
      const from = model.node(gesture.fromId);
      if (from) {
        const rect = viewportRect();
        const targetId = targetNodeAt(rect.left + gesture.current.x, rect.top + gesture.current.y);
        const target = targetId && targetId !== from.id ? model.node(targetId) : null;
        const toward = target ? nodeCenter(target) : screenToWorld(gesture.current);
        const start = researchRectBoundaryPoint(nodeVisualBounds(from), toward);
        const end = target
          ? researchRectBoundaryPoint(nodeVisualBounds(target), nodeCenter(from))
          : toward;
        appendActiveLine(worldToScreen(start), worldToScreen(end), true);
      }
    } else if (gesture.type === 'data-edge-create') {
      const from = model.node(gesture.fromId);
      const target = gesture.target && model.node(gesture.target.nodeId);
      if (from) {
        const end = target
          ? worldToScreen(portWorldPoint(target, gesture.target.port, gesture.target.direction))
          : gesture.current;
        appendActiveLine(
          worldToScreen(portWorldPoint(from, gesture.fromPort, gesture.fromDirection)),
          end,
          true,
          true,
          !!gesture.target && !gesture.targetValid,
        );
      }
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
    if (onSelectionChange) onSelectionChange({
      nodeIds: Array.from(selectedNodeIds), edgeIds: Array.from(selectedEdgeIds),
      primaryNode: selectedNodeIds.size === 1 ? model.node(Array.from(selectedNodeIds)[0]) : null,
      primaryEdge: selectedEdgeIds.size === 1 ? model.edge(Array.from(selectedEdgeIds)[0]) : null,
    });
  }

  function clearSelection() {
    selectedNodeIds.clear();
    selectedEdgeIds.clear();
    renderSelection();
  }

  function selectNodes(nodeIds) {
    const requested = new Set(Array.from(nodeIds || [], String));
    selectedNodeIds.clear();
    selectedEdgeIds.clear();
    model.nodes().forEach((node) => { if (requested.has(node.id)) selectedNodeIds.add(node.id); });
    renderSelection();
    return Array.from(selectedNodeIds);
  }

  function normalizedCreationDescriptor(source) {
    const candidate = typeof source === 'string' ? { type: source } : source && typeof source === 'object' ? source : {};
    const type = registry.definition(String(candidate.type || '')) ? String(candidate.type) : 'note';
    const descriptor = { type };
    if (candidate.label != null) descriptor.label = String(candidate.label);
    if (candidate.config && typeof candidate.config === 'object') descriptor.config = JSON.parse(JSON.stringify(candidate.config));
    if (Number.isFinite(Number(candidate.width))) descriptor.width = Number(candidate.width);
    if (Number.isFinite(Number(candidate.height))) descriptor.height = Number(candidate.height);
    return descriptor;
  }

  function setCreationTool(nextCreation) {
    const normalized = normalizedCreationDescriptor(nextCreation);
    const before = JSON.stringify(pendingCreation);
    pendingCreation = normalized;
    viewport.dataset.researchCreationTool = pendingCreation.type;
    if (before !== JSON.stringify(pendingCreation) && onCreationToolChange) {
      onCreationToolChange(getCreationTool());
    }
    return getCreationTool();
  }

  function getCreationTool() {
    return JSON.parse(JSON.stringify(pendingCreation));
  }

  function setConnectionKind(nextKind) {
    connectionKind = CONNECTION_KINDS.has(String(nextKind || '')) ? String(nextKind) : 'wire';
    viewport.dataset.researchConnectionKind = connectionKind;
    return connectionKind;
  }

  function getConnectionKind() {
    return connectionKind;
  }

  function selectOnlyNode(nodeId) {
    selectedNodeIds.clear();
    selectedEdgeIds.clear();
    selectedNodeIds.add(nodeId);
    renderSelection();
  }

  function createNodeAt(worldPoint, options = {}) {
    const type = String(options.type || pendingCreation.type || 'note');
    const defaults = registry.createNode(type, options);
    if (!defaults) return null;
    const source = {
      x: worldPoint.x - 84,
      y: worldPoint.y - 32,
      ...defaults,
      width: options.width,
      height: options.height,
    };
    const node = options.fromId
      ? model.createLinkedNode(options.fromId, source)
      : model.createNode(source);
    if (!node) return null;
    selectOnlyNode(node.id);
    if (options.edit !== false && type === 'note') beginEdit(node.id, options.replaceText);
    return node;
  }

  function beginEdit(nodeId, replaceText) {
    const node = model.node(nodeId);
    const element = nodeElements.get(nodeId);
    if (!node || !element) return false;
    if (editing && editing.nodeId !== nodeId) commitEdit();
    const text = element.querySelector('[data-node-text]');
    const definition = registry.definition(node.type);
    const displayedDefault = definition && node.label === definition.defaultLabel ? T(node.label) : '';
    editing = { nodeId, originalText: node.label, displayedDefault };
    element.classList.add('is-editing');
    text.dataset.userContent = '';
    text.contentEditable = 'true';
    text.spellcheck = false;
    text.textContent = replaceText == null ? (displayedDefault || node.label) : String(replaceText);
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
    let value = text ? text.textContent.replace(/\r\n?/g, '\n') : state.originalText;
    if (state.displayedDefault && value === state.displayedDefault) value = state.originalText;
    const height = element ? Math.max(64, Math.ceil(element.scrollHeight)) : 64;
    editing = null;
    finishEditElement(state.nodeId);
    model.updateNode(state.nodeId, { label: value, height });
    return true;
  }

  function createTypedNode(type, worldPoint) {
    if (!registry.definition(type)) return null;
    if (editing) commitEdit();
    let point = worldPoint;
    if (!point || !Number.isFinite(Number(point.x)) || !Number.isFinite(Number(point.y))) {
      const rect = viewportRect();
      point = screenToWorld({ x: rect.width / 2, y: rect.height / 2 });
    }
    return createNodeAt({ x: Number(point.x), y: Number(point.y) }, { type, edit: false });
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

  function clearWireTargets() {
    surface.querySelectorAll('.research-port.is-compatible, .research-port.is-incompatible').forEach((port) => {
      port.classList.remove('is-compatible', 'is-incompatible');
    });
  }

  function normalizeWireCandidate(start, target) {
    if (!start || !target || start.direction === target.direction) return null;
    const from = start.direction === 'output' ? start : target;
    const to = start.direction === 'input' ? start : target;
    if (from.direction !== 'output' || to.direction !== 'input') return null;
    return { from, to };
  }

  function wireCandidateIsValid(state, target) {
    const candidate = normalizeWireCandidate({
      nodeId: state.fromId,
      port: state.fromPort,
      direction: state.fromDirection,
    }, target);
    return !!candidate && model.canCreateWire(
      candidate.from.nodeId,
      candidate.from.port,
      candidate.to.nodeId,
      candidate.to.port,
      { ignoreEdgeId: state.rewireEdgeId },
    );
  }

  function markWireTargets(state) {
    clearWireTargets();
    surface.querySelectorAll('[data-research-port]').forEach((port) => {
      const targetNode = port.closest('[data-node-id]');
      if (!targetNode) return;
      const target = {
        nodeId: targetNode.dataset.nodeId,
        port: port.dataset.researchPort,
        direction: port.dataset.researchPortDirection,
      };
      if (target.nodeId === state.fromId && target.port === state.fromPort
        && target.direction === state.fromDirection) return;
      const compatible = wireCandidateIsValid(state, target);
      port.classList.add(compatible ? 'is-compatible' : 'is-incompatible');
    });
  }

  function startDataEdgeCreate(event, nodeId, fromPort, fromDirection) {
    selectedEdgeIds.clear();
    if (!selectedNodeIds.has(nodeId)) selectOnlyNode(nodeId);
    const node = model.node(nodeId);
    const startPort = node && registry.port(node, fromPort, fromDirection);
    if (!startPort) return;
    const rewireEdge = fromDirection === 'input' && startPort.channel === 'value'
      ? model.edges().find((edge) => edge.kind === 'wire'
        && edge.to.nodeId === nodeId && edge.to.portId === fromPort)
      : null;
    gesture = {
      type: 'data-edge-create',
      pointerId: event.pointerId,
      fromId: nodeId,
      fromPort,
      fromDirection,
      fromChannel: startPort.channel,
      rewireEdgeId: rewireEdge ? rewireEdge.id : '',
      target: null,
      targetValid: false,
      current: eventPoint(event),
    };
    viewport.setPointerCapture(event.pointerId);
    markWireTargets(gesture);
    if (gesture.rewireEdgeId) drawEdgesImmediately();
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
    const point = eventPoint(event);
    gesture = {
      type: 'pan',
      pointerId: event.pointerId,
      start: point,
      camera: { ...camera },
      velocityX: null,
      velocityY: null,
      lastMoveX: point.x,
      lastMoveY: point.y,
      lastMoveTimestamp: performance.now(),
    };
    viewport.classList.add('is-panning');
    viewport.setPointerCapture(event.pointerId);
  }

  function recordPrimaryPress(event) {
    if (event.button !== 0) return;
    const node = event.target.closest && event.target.closest('[data-node-id]');
    const blank = event.target === viewport || event.target === surface || event.target === edgesCanvas;
    primaryPresses.push({ kind: node ? 'node' : blank ? 'blank' : 'other', at: performance.now() });
    while (primaryPresses.length > 2) primaryPresses.shift();
  }

  function stableBlankDoubleClick(event) {
    if (!(event.target === viewport || event.target === surface || event.target === edgesCanvas)) return false;
    if (event.detail === 0) return true;
    if (primaryPresses.length < 2) return false;
    const pair = primaryPresses.slice(-2);
    return pair.every((press) => press.kind === 'blank') && pair[1].at - pair[0].at <= 650;
  }

  function onPointerDown(event) {
    if (event.button !== 0 && event.button !== 1) return;
    cancelPanInertia();
    freezeCameraForInteraction();
    if (event.altKey) viewport.classList.add('is-alt-connecting');
    recordPrimaryPress(event);
    lastPointer = eventPoint(event);
    if (editing && !event.target.closest(`[data-node-id="${CSS.escape(editing.nodeId)}"]`)) commitEdit();
    if (event.target.closest && event.target.closest('[data-research-zoom-indicator]')) return;
    if (isEditableTarget(event.target)) return;
    viewport.focus({ preventScroll: true });
    if (event.button === 1 || (event.button === 0 && spaceHeld)) {
      event.preventDefault();
      startPan(event);
      return;
    }
    if (event.button !== 0) return;
    const action = event.target.closest('[data-node-action]');
    if (action) {
      event.preventDefault(); event.stopPropagation();
      const actionNode = action.closest('[data-node-id]');
      if (actionNode && onNodeAction) onNodeAction(actionNode.dataset.nodeId);
      return;
    }
    const port = event.target.closest('[data-research-port]');
    if (port) {
      event.preventDefault();
      event.stopPropagation();
      const nodeElement = port.closest('[data-node-id]');
      if (!nodeElement) return;
      const nodeId = nodeElement.dataset.nodeId;
      if (event.altKey && connectionKind === 'wire') {
        startDataEdgeCreate(
          event,
          nodeId,
          port.dataset.researchPort,
          port.dataset.researchPortDirection,
        );
      } else selectOnlyNode(nodeId);
      return;
    }
    const nodeElement = event.target.closest('[data-node-id]');
    if (nodeElement) {
      event.preventDefault();
      const nodeId = nodeElement.dataset.nodeId;
      if (event.altKey && connectionKind === 'relation') startEdgeCreate(event, nodeId);
      else if (event.altKey) selectOnlyNode(nodeId);
      else startNodeDrag(event, nodeId);
      return;
    }
    event.preventDefault();
    if (event.altKey) return;
    startBackgroundGesture(event);
  }

  function onPointerMove(event) {
    const point = eventPoint(event);
    const rect = viewport.getBoundingClientRect();
    if (event.clientX >= rect.left && event.clientX <= rect.right
      && event.clientY >= rect.top && event.clientY <= rect.bottom) lastPointer = point;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    if (gesture.type === 'pan') {
      const now = performance.now();
      const elapsed = now - gesture.lastMoveTimestamp;
      if (elapsed > 0) {
        const velocityX = (point.x - gesture.lastMoveX) / elapsed;
        const velocityY = (point.y - gesture.lastMoveY) / elapsed;
        gesture.velocityX = gesture.velocityX == null ? velocityX : gesture.velocityX * .4 + velocityX * .6;
        gesture.velocityY = gesture.velocityY == null ? velocityY : gesture.velocityY * .4 + velocityY * .6;
      }
      gesture.lastMoveX = point.x;
      gesture.lastMoveY = point.y;
      gesture.lastMoveTimestamp = now;
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
    if (gesture.type === 'data-edge-create') {
      gesture.current = point;
      gesture.target = targetPortAt(event.clientX, event.clientY);
      gesture.targetValid = !!gesture.target && wireCandidateIsValid(gesture, gesture.target);
      renderActiveEdges();
      return;
    }
    if (gesture.type === 'box') {
      gesture.current = point;
      if (!gesture.moved && Math.hypot(point.x - gesture.start.x, point.y - gesture.start.y) >= DRAG_THRESHOLD) {
        gesture.moved = true;
        drawEdgesImmediately();
      }
      if (gesture.moved) updateFrame(gesture.start, point);
      return;
    }
    if (gesture.type === 'node-drag') {
      const dx = (point.x - gesture.start.x) / camera.scale;
      const dy = (point.y - gesture.start.y) / camera.scale;
      if (!gesture.moved && Math.hypot(point.x - gesture.start.x, point.y - gesture.start.y) >= DRAG_THRESHOLD) {
        gesture.moved = true;
        drawEdgesImmediately();
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
    if (element && element.closest && element.closest('[data-research-port]')) return null;
    const nodeElement = element && element.closest && element.closest('[data-node-id]');
    return nodeElement ? nodeElement.dataset.nodeId : null;
  }

  function targetPortAt(clientX, clientY) {
    const element = document.elementFromPoint(clientX, clientY);
    const port = element && element.closest
      && element.closest('[data-research-port]');
    const nodeElement = port && port.closest('[data-node-id]');
    return port && nodeElement ? {
      nodeId: nodeElement.dataset.nodeId,
      port: port.dataset.researchPort,
      direction: port.dataset.researchPortDirection,
    } : null;
  }

  function finishGesture(event, commit = true) {
    if (!gesture) return;
    const state = gesture;
    gesture = null;
    if (state.pointerId != null && viewport.hasPointerCapture(state.pointerId)) {
      viewport.releasePointerCapture(state.pointerId);
    }
    viewport.classList.remove('is-panning');
    clearWireTargets();
    nodeElements.forEach((element) => element.classList.remove('is-dragging'));
    selectionFrame.hidden = true;
    if (!altHeld) viewport.classList.remove('is-alt-connecting');
    if (state.type === 'pan' && commit && event) {
      startPanInertia(state);
    } else if (state.type === 'node-drag' && state.moved) {
      if (commit) model.commitFrom(state.before, { kind: 'node-move', nodeIds: Object.keys(state.positions), alreadyEmitted: true });
      else model.restore(state.before, true);
      refreshEdgeCache(state.edgeIds);
      redrawMinimap();
      drawEdgesImmediately();
      clearActiveEdges();
    } else if (state.type === 'edge-create' && commit && event) {
      clearActiveEdges();
      const targetId = targetNodeAt(event.clientX, event.clientY);
      if (targetId && targetId !== state.fromId) model.createEdge(state.fromId, targetId, { kind: 'relation' });
    } else if (state.type === 'data-edge-create' && commit && event) {
      clearActiveEdges();
      const target = targetPortAt(event.clientX, event.clientY);
      const candidate = normalizeWireCandidate({
        nodeId: state.fromId,
        port: state.fromPort,
        direction: state.fromDirection,
      }, target);
      if (candidate && model.canCreateWire(
        candidate.from.nodeId,
        candidate.from.port,
        candidate.to.nodeId,
        candidate.to.port,
        { ignoreEdgeId: state.rewireEdgeId },
      )) {
        if (state.rewireEdgeId) {
          model.reconnectWire(
            state.rewireEdgeId,
            candidate.from.nodeId,
            candidate.from.port,
            candidate.to.nodeId,
            candidate.to.port,
          );
        } else {
          model.createEdge(candidate.from.nodeId, candidate.to.nodeId, {
            kind: 'wire',
            fromPortId: candidate.from.port,
            toPortId: candidate.to.port,
          });
        }
      }
      drawEdgesImmediately();
    } else {
      clearActiveEdges();
      if (state.type === 'data-edge-create') drawEdgesImmediately();
    }
  }

  function onPointerUp(event) {
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    finishGesture(event, true);
  }

  function onDoubleClick(event) {
    const hitElement = document.elementFromPoint(event.clientX, event.clientY);
    const nodeElement = event.target.closest('[data-node-id]')
      || hitElement && hitElement.closest && hitElement.closest('[data-node-id]');
    if (nodeElement) {
      event.preventDefault();
      selectOnlyNode(nodeElement.dataset.nodeId);
      beginEdit(nodeElement.dataset.nodeId);
      return;
    }
    if (stableBlankDoubleClick(event)) {
      event.preventDefault();
      const worldPoint = screenToWorld(eventPoint(event));
      createNodeAt(worldPoint, { ...getCreationTool(), edit: false });
    }
  }

  function onWheel(event) {
    event.preventDefault();
    const point = eventPoint(event);
    const direction = event.deltaY > 0 ? -1 : 1;
    const factor = Math.exp(direction * Math.min(Math.abs(event.deltaY), 200) / 200 * Math.log(1.1) * zoomSpeed);
    zoomAt(targetCamera.scale * factor, point);
  }

  function syncInteractionPreferenceControls() {
    if (panSpeedInput) panSpeedInput.value = String(panSpeed);
    if (panInertiaInput) panInertiaInput.value = String(panInertia);
    if (zoomSpeedInput) zoomSpeedInput.value = String(zoomSpeed);
    if (panSpeedValue) panSpeedValue.textContent = String(panSpeed);
    if (panInertiaValue) panInertiaValue.textContent = Math.round(panInertia * 100) + '%';
    if (zoomSpeedValue) zoomSpeedValue.textContent = Number(zoomSpeed.toFixed(1)) + '×';
    if (coordinatesVisibleInput) coordinatesVisibleInput.checked = coordinatesVisible;
    if (coordinateLabelsVisibleInput) {
      coordinateLabelsVisibleInput.checked = coordinateLabelsVisible;
      coordinateLabelsVisibleInput.disabled = !coordinatesVisible;
    }
  }

  function saveInteractionPreference(key, value) {
    try { localStorage.setItem(key, String(value)); } catch (_error) {}
  }

  function installInteractionPreferenceListeners(signal) {
    syncInteractionPreferenceControls();
    if (panSpeedInput) panSpeedInput.addEventListener('input', () => {
      const value = Number.parseInt(panSpeedInput.value, 10);
      if (!Number.isFinite(value) || value < 1 || value > 20) return;
      panSpeed = value;
      syncInteractionPreferenceControls();
      saveInteractionPreference('research:panSpeed:v1', value);
    }, { signal });
    if (panInertiaInput) panInertiaInput.addEventListener('input', () => {
      const value = Number.parseFloat(panInertiaInput.value);
      if (!Number.isFinite(value) || value < 0 || value > 1) return;
      panInertia = value;
      if (panInertia === 0) cancelPanInertia();
      syncInteractionPreferenceControls();
      saveInteractionPreference('research:panInertia:v1', value);
    }, { signal });
    if (zoomSpeedInput) zoomSpeedInput.addEventListener('input', () => {
      const value = Number.parseFloat(zoomSpeedInput.value);
      if (!Number.isFinite(value) || value < .5 || value > 3) return;
      zoomSpeed = value;
      syncInteractionPreferenceControls();
      saveInteractionPreference('research:zoomSpeed:v1', value);
    }, { signal });
    if (coordinatesVisibleInput) coordinatesVisibleInput.addEventListener('change', () => {
      coordinatesVisible = coordinatesVisibleInput.checked;
      syncInteractionPreferenceControls();
      saveInteractionPreference(COORDINATES_VISIBLE_KEY, coordinatesVisible ? '1' : '0');
      scheduleDraw();
    }, { signal });
    if (coordinateLabelsVisibleInput) coordinateLabelsVisibleInput.addEventListener('change', () => {
      coordinateLabelsVisible = coordinateLabelsVisibleInput.checked;
      syncInteractionPreferenceControls();
      saveInteractionPreference(COORDINATE_LABELS_VISIBLE_KEY, coordinateLabelsVisible ? '1' : '0');
      scheduleDraw();
    }, { signal });
  }

  function resetInteractionPreferences() {
    panSpeed = 8;
    panInertia = .15;
    zoomSpeed = 1;
    coordinatesVisible = false;
    coordinateLabelsVisible = false;
    cancelPanInertia();
    try {
      localStorage.removeItem('research:panSpeed:v1');
      localStorage.removeItem('research:panInertia:v1');
      localStorage.removeItem('research:zoomSpeed:v1');
      localStorage.removeItem(COORDINATES_VISIBLE_KEY);
      localStorage.removeItem(COORDINATE_LABELS_VISIBLE_KEY);
    } catch (_error) {}
    syncInteractionPreferenceControls();
    scheduleDraw();
    return { panSpeed, panInertia, zoomSpeed, coordinatesVisible, coordinateLabelsVisible };
  }

  function createSibling(node) {
    const incoming = model.edges().find((edge) => edge.kind === 'relation' && edge.toNodeId === node.id);
    const sibling = createNodeAt({
      x: node.x + node.width / 2,
      y: node.y + node.height + 76 + 32,
    }, { type: 'note', edit: false, fromId: incoming ? incoming.fromNodeId : null });
    if (!sibling) return;
    beginEdit(sibling.id);
  }

  function duplicateSelection() {
    if (!selectedNodeIds.size) return null;
    const selected = Array.from(selectedNodeIds, (nodeId) => model.node(nodeId)).filter(Boolean);
    if (!selected.length) return null;
    const minimumX = Math.min(...selected.map((node) => node.x));
    const minimumY = Math.min(...selected.map((node) => node.y));
    let dx = 28;
    let dy = 28;
    if (lastPointer) {
      const anchor = screenToWorld(lastPointer);
      dx = anchor.x - minimumX;
      dy = anchor.y - minimumY;
    }
    const result = model.duplicateNodes(selectedNodeIds, { dx, dy });
    if (!result) return null;
    selectNodes(result.nodeIds);
    return result;
  }

  function onKeyDown(event) {
    if (event.defaultPrevented) return;
    if (event.key === 'Alt') {
      altHeld = true;
      viewport.classList.add('is-alt-connecting');
      return;
    }
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
    if (modifier && (event.key === 'd' || event.key === 'D')) {
      event.preventDefault();
      duplicateSelection();
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
      const removedEdgeIds = model.incidentEdgeIds(selectedNodeIds);
      selectedEdgeIds.forEach((edgeId) => removedEdgeIds.add(edgeId));
      animateRemoval(new Set(selectedNodeIds), removedEdgeIds);
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
      createNodeAt(screenToWorld(lastPointer || { x: rect.width / 2, y: rect.height / 2 }), { type: 'note' });
      return;
    }
    const panKeys = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown']);
    const wasd = !onlyNode && event.key.length === 1
      ? { a: 'ArrowLeft', d: 'ArrowRight', w: 'ArrowUp', s: 'ArrowDown' }[event.key.toLowerCase()]
      : null;
    const panKey = wasd || event.key;
    if (panKeys.has(panKey) && !event.altKey && !modifier) {
      event.preventDefault();
      pressedPanKeys.add(panKey);
      startArrowPan();
    }
  }

  function onKeyUp(event) {
    if (event.key === 'Alt') {
      altHeld = false;
      viewport.classList.remove('is-alt-connecting');
      return;
    }
    if (event.code === 'Space') {
      spaceHeld = false;
      viewport.classList.remove('is-space-held');
    }
    const panKey = event.key.length === 1
      ? { a: 'ArrowLeft', d: 'ArrowRight', w: 'ArrowUp', s: 'ArrowDown' }[event.key.toLowerCase()]
      : event.key;
    if (panKey && pressedPanKeys.has(panKey)) {
      pressedPanKeys.delete(panKey);
      if (!pressedPanKeys.size) stopArrowPan();
    }
  }

  function visibleWorldRect() {
    const rect = viewportRect();
    return {
      left: -camera.x / camera.scale,
      top: -camera.y / camera.scale,
      right: (rect.width - camera.x) / camera.scale,
      bottom: (rect.height - camera.y) / camera.scale,
    };
  }

  function computeMinimapMapping() {
    if (!contentBoundsCache) {
      contentBoundsCache = model.nodes().reduce((result, node) => {
        const bounds = nodeVisualBounds(node);
        return {
          left: Math.min(result.left, bounds.left),
          top: Math.min(result.top, bounds.top),
          right: Math.max(result.right, bounds.right),
          bottom: Math.max(result.bottom, bounds.bottom),
        };
      }, { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity });
    }
    const visible = visibleWorldRect();
    const left = Math.min(contentBoundsCache.left, visible.left) - 60;
    const top = Math.min(contentBoundsCache.top, visible.top) - 60;
    const right = Math.max(contentBoundsCache.right, visible.right) + 60;
    const bottom = Math.max(contentBoundsCache.bottom, visible.bottom) + 60;
    const width = Math.max(1, right - left);
    const height = Math.max(1, bottom - top);
    const scale = Math.min(minimapSize.width / width, minimapSize.height / height);
    return {
      scale,
      left,
      top,
      offsetX: (minimapSize.width - width * scale) / 2,
      offsetY: (minimapSize.height - height * scale) / 2,
    };
  }

  function sameMinimapMapping(first, second) {
    return !!first && !!second
      && Math.abs(first.left - second.left) < .5
      && Math.abs(first.top - second.top) < .5
      && Math.abs(first.offsetX - second.offsetX) < .5
      && Math.abs(first.offsetY - second.offsetY) < .5
      && Math.abs(first.scale - second.scale) < .0001;
  }

  function positionMinimapNode(dot, node, mapping = minimapMapping) {
    if (!mapping || !dot || !node) return;
    const bounds = nodeVisualBounds(node);
    dot.style.left = mapping.offsetX + (bounds.left - mapping.left) * mapping.scale + 'px';
    dot.style.top = mapping.offsetY + (bounds.top - mapping.top) * mapping.scale + 'px';
    dot.style.width = Math.max(2, (bounds.right - bounds.left) * mapping.scale) + 'px';
    dot.style.height = Math.max(2, (bounds.bottom - bounds.top) * mapping.scale) + 'px';
  }

  function placeMinimapViewbox() {
    if (!minimapMapping || minimap.hidden) return;
    const visible = visibleWorldRect();
    const left = minimapMapping.offsetX + (visible.left - minimapMapping.left) * minimapMapping.scale;
    const top = minimapMapping.offsetY + (visible.top - minimapMapping.top) * minimapMapping.scale;
    const width = Math.max(4, (visible.right - visible.left) * minimapMapping.scale);
    const height = Math.max(4, (visible.bottom - visible.top) * minimapMapping.scale);
    minimapViewboxRect = { left, top, width, height };
    minimapViewbox.style.left = left + 'px';
    minimapViewbox.style.top = top + 'px';
    minimapViewbox.style.width = width + 'px';
    minimapViewbox.style.height = height + 'px';
  }

  function redrawMinimap(change = null, reuseBounds = false) {
    if (minimapRebaseTimer) clearTimeout(minimapRebaseTimer);
    minimapRebaseTimer = 0;
    const nodes = model.nodes();
    minimap.hidden = !nodes.length;
    if (!nodes.length) {
      minimapNodes.replaceChildren();
      minimapNodeElements.clear();
      minimapMapping = null;
      minimapNodeMapping = null;
      minimapViewboxRect = null;
      contentBoundsCache = null;
      return;
    }
    if (!reuseBounds) contentBoundsCache = null;
    const nextMapping = computeMinimapMapping();
    const changedNodeIds = new Set(change && Array.isArray(change.nodeIds) ? change.nodeIds : []);
    const incremental = !!change && !change.topology
      && sameMinimapMapping(nextMapping, minimapNodeMapping);
    minimapMapping = nextMapping;
    minimapNodeMapping = nextMapping;
    minimapNodes.style.transform = '';
    const seen = new Set();
    nodes.forEach((node) => {
      seen.add(node.id);
      let dot = minimapNodeElements.get(node.id);
      if (!dot) {
        dot = document.createElement('div');
        dot.className = 'research-minimap-node';
        dot.dataset.minimapNodeId = node.id;
        minimapNodes.appendChild(dot);
        minimapNodeElements.set(node.id, dot);
      }
      if (!incremental || changedNodeIds.has(node.id)) positionMinimapNode(dot, node, nextMapping);
    });
    minimapNodeElements.forEach((dot, nodeId) => {
      if (!seen.has(nodeId)) { dot.remove(); minimapNodeElements.delete(nodeId); }
    });
    placeMinimapViewbox();
  }

  function updateMinimapNodes(nodeIds) {
    if (!minimapNodeMapping) return;
    nodeIds.forEach((nodeId) => {
      const node = model.node(nodeId);
      const dot = minimapNodeElements.get(nodeId);
      if (node && dot) positionMinimapNode(dot, node, minimapNodeMapping);
    });
    placeMinimapViewbox();
  }

  function updateMinimapViewport() {
    if (minimap.hidden || !minimapNodeMapping || !model.nodes().length) return;
    const next = computeMinimapMapping();
    minimapMapping = next;
    const base = minimapNodeMapping;
    const scale = next.scale / base.scale;
    const x = next.offsetX + (base.left - next.left) * next.scale - base.offsetX * scale;
    const y = next.offsetY + (base.top - next.top) * next.scale - base.offsetY * scale;
    minimapNodes.style.transformOrigin = '0 0';
    minimapNodes.style.transform = `translate(${x}px, ${y}px) scale(${scale})`;
    placeMinimapViewbox();
    if (minimapRebaseTimer) clearTimeout(minimapRebaseTimer);
    minimapRebaseTimer = 0;
    if (active) {
      minimapRebaseTimer = setTimeout(() => {
        minimapRebaseTimer = 0;
        if (!sameMinimapMapping(minimapMapping, minimapNodeMapping)) redrawMinimap(null, true);
      }, 160);
    }
  }

  function minimapToWorld(x, y) {
    if (!minimapMapping) return { x: 0, y: 0 };
    return {
      x: minimapMapping.left + (x - minimapMapping.offsetX) / minimapMapping.scale,
      y: minimapMapping.top + (y - minimapMapping.offsetY) / minimapMapping.scale,
    };
  }

  function centerCameraOnWorld(point, immediate = false) {
    const rect = viewportRect();
    const next = {
      x: rect.width / 2 - point.x * targetCamera.scale,
      y: rect.height / 2 - point.y * targetCamera.scale,
      scale: targetCamera.scale,
    };
    if (immediate) setCamera(next);
    else animateCamera(next);
  }

  function onMinimapPointerDown(event) {
    if (!minimapMapping || event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    cancelPanInertia();
    freezeCameraForInteraction();
    const rect = minimap.getBoundingClientRect();
    const local = { x: event.clientX - rect.left, y: event.clientY - rect.top };
    const inside = minimapViewboxRect
      && local.x >= minimapViewboxRect.left
      && local.x <= minimapViewboxRect.left + minimapViewboxRect.width
      && local.y >= minimapViewboxRect.top
      && local.y <= minimapViewboxRect.top + minimapViewboxRect.height;
    const world = minimapToWorld(local.x, local.y);
    let offsetX = 0;
    let offsetY = 0;
    if (inside) {
      const view = viewportRect();
      offsetX = world.x - (view.width / 2 - camera.x) / camera.scale;
      offsetY = world.y - (view.height / 2 - camera.y) / camera.scale;
    } else centerCameraOnWorld(world, false);
    const pointerId = event.pointerId;
    minimap.setPointerCapture(pointerId);
    const onMove = (moveEvent) => {
      if (moveEvent.pointerId !== pointerId) return;
      const point = minimapToWorld(moveEvent.clientX - rect.left, moveEvent.clientY - rect.top);
      centerCameraOnWorld({ x: point.x - offsetX, y: point.y - offsetY }, true);
    };
    const onUp = (upEvent) => {
      if (upEvent.pointerId !== pointerId) return;
      if (minimap.hasPointerCapture(pointerId)) minimap.releasePointerCapture(pointerId);
      minimap.removeEventListener('pointermove', onMove);
      minimap.removeEventListener('pointerup', onUp);
      minimap.removeEventListener('pointercancel', onUp);
    };
    minimap.addEventListener('pointermove', onMove);
    minimap.addEventListener('pointerup', onUp);
    minimap.addEventListener('pointercancel', onUp);
  }

  function onModelChange(change) {
    if (change.topology) {
      syncNodeElements();
      model.nodes().forEach((node) => measureNodeLayout(node.id));
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
    refreshEdgeCache(model.incidentEdgeIds(new Set(nodeIds)));
    redrawMinimap(change);
    scheduleDraw();
  }

  function handleNodeResize(entries) {
    const changedNodeIds = new Set();
    entries.forEach((entry) => {
      const nodeId = entry.target && entry.target.dataset.nodeId;
      if (nodeId && measureNodeLayout(nodeId)) changedNodeIds.add(nodeId);
    });
    if (!changedNodeIds.size) return;
    refreshEdgeCache(model.incidentEdgeIds(changedNodeIds));
    if (gesture) renderActiveEdges();
    redrawMinimap({ topology: false, nodeIds: Array.from(changedNodeIds) });
    scheduleDraw();
  }

  unsubscribe = model.subscribe(onModelChange);
  syncNodeElements();
  rebuildEdgeCache();
  redrawMinimap();
  applyCamera();

  function getViewState() {
    return { ...targetCamera };
  }

  function cancelProjectionRender() {
    if (projectionRaf) cancelAnimationFrame(projectionRaf);
    projectionRaf = 0;
    projectionNodeIds = [];
    projectionCursor = 0;
  }

  function renderProjectionNode(nodeId) {
    const node = model.node(nodeId);
    const element = nodeElements.get(nodeId);
    if (node && element) syncComputeDecorations(element, node);
  }

  function renderProjectionSlice() {
    projectionRaf = 0;
    if (disposed || !projectionNodeIds.length) return;
    const started = performance.now();
    let rendered = 0;
    while (projectionCursor < projectionNodeIds.length && rendered < PROJECTION_NODES_PER_FRAME) {
      renderProjectionNode(projectionNodeIds[projectionCursor++]);
      rendered += 1;
      if (performance.now() - started >= PROJECTION_FRAME_BUDGET_MS) break;
    }
    if (projectionCursor < projectionNodeIds.length) {
      projectionRaf = requestAnimationFrame(renderProjectionSlice);
      return;
    }
    projectionNodeIds = [];
    projectionCursor = 0;
  }

  function setComputeProjection(nextProjection, options = {}) {
    computeProjection = nextProjection && typeof nextProjection === 'object' ? nextProjection : {};
    if (!options.deferred) {
      cancelProjectionRender();
      model.nodes().forEach((node) => renderProjectionNode(node.id));
      return;
    }
    if (!projectionNodeIds.length) {
      projectionNodeIds = model.nodes().map((node) => node.id);
      projectionCursor = 0;
    }
    if (!projectionRaf) projectionRaf = requestAnimationFrame(renderProjectionSlice);
  }

  function setModel(nextModel, viewState = {}) {
    if (!nextModel || disposed) return false;
    if (editing) commitEdit();
    if (gesture) finishGesture(null, true);
    if (unsubscribe) unsubscribe();
    unsubscribe = null;
    if (drawRaf) cancelAnimationFrame(drawRaf);
    drawRaf = 0;
    cancelCameraAnimation();
    cancelPanInertia();
    stopArrowPan();
    if (minimapRebaseTimer) clearTimeout(minimapRebaseTimer);
    minimapRebaseTimer = 0;
    cancelProjectionRender();
    selectedNodeIds.clear();
    selectedEdgeIds.clear();
    if (nodeResizeObserver) nodeResizeObserver.disconnect();
    nodeElements.forEach((element) => element.remove());
    nodeElements.clear();
    nodeLayoutCache.clear();
    clearRemovalGhosts();
    edgePathCache.clear();
    edgeSpatialGrid.clear();
    clearActiveEdges();
    selectionFrame.hidden = true;
    minimapNodes.replaceChildren();
    minimapNodeElements.clear();
    minimap.hidden = true;
    minimapMapping = null;
    minimapNodeMapping = null;
    minimapViewboxRect = null;
    contentBoundsCache = null;
    computeProjection = {};
    model = nextModel;
    unsubscribe = model.subscribe(onModelChange);
    camera = {
      x: Number.isFinite(Number(viewState.x)) ? Number(viewState.x) : 0,
      y: Number.isFinite(Number(viewState.y)) ? Number(viewState.y) : 0,
      scale: clamp(Number.isFinite(Number(viewState.scale)) ? Number(viewState.scale) : 1, MIN_SCALE, MAX_SCALE),
    };
    targetCamera = { ...camera };
    syncNodeElements();
    rebuildEdgeCache();
    redrawMinimap();
    applyCamera();
    if (active) drawEdgesImmediately();
    return true;
  }

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
    zoomIndicator.addEventListener('click', resetZoom, { signal });
    installInteractionPreferenceListeners(signal);
    window.addEventListener('keydown', onKeyDown, { capture: true, signal });
    window.addEventListener('keyup', onKeyUp, { capture: true, signal });
    window.addEventListener('blur', () => {
      spaceHeld = false;
      altHeld = false;
      viewport.classList.remove('is-space-held', 'is-alt-connecting');
      stopArrowPan();
      cancelPanInertia();
      if (gesture) finishGesture(null, true);
    }, { signal });
    viewportResizeObserver = typeof ResizeObserver === 'function' ? new ResizeObserver(resizeCanvas) : null;
    if (viewportResizeObserver) viewportResizeObserver.observe(viewport);
    minimapResizeObserver = typeof ResizeObserver === 'function' ? new ResizeObserver(() => {
      const width = minimap.clientWidth;
      const height = minimap.clientHeight;
      if (!width || !height || (width === minimapSize.width && height === minimapSize.height)) return;
      minimapSize = { width, height };
      redrawMinimap();
    }) : null;
    if (minimapResizeObserver) minimapResizeObserver.observe(minimap);
    nodeResizeObserver = typeof ResizeObserver === 'function' ? new ResizeObserver(handleNodeResize) : null;
    if (nodeResizeObserver) nodeElements.forEach((element) => nodeResizeObserver.observe(element));
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
    if (viewportResizeObserver) viewportResizeObserver.disconnect();
    viewportResizeObserver = null;
    if (minimapResizeObserver) minimapResizeObserver.disconnect();
    minimapResizeObserver = null;
    if (nodeResizeObserver) nodeResizeObserver.disconnect();
    nodeResizeObserver = null;
    if (drawRaf) cancelAnimationFrame(drawRaf);
    drawRaf = 0;
    cancelCameraAnimation();
    cancelPanInertia();
    stopArrowPan();
    if (minimapRebaseTimer) clearTimeout(minimapRebaseTimer);
    minimapRebaseTimer = 0;
    active = false;
    camera = { ...targetCamera };
    applyCamera();
    if (minimapRebaseTimer) clearTimeout(minimapRebaseTimer);
    minimapRebaseTimer = 0;
    cancelProjectionRender();
    spaceHeld = false;
    altHeld = false;
    viewport.classList.remove('is-space-held', 'is-panning', 'is-alt-connecting');
    return true;
  }

  function dispose() {
    if (disposed) return true;
    suspend();
    disposed = true;
    if (unsubscribe) unsubscribe();
    unsubscribe = null;
    nodeElements.clear();
    nodeLayoutCache.clear();
    minimapNodeElements.clear();
    edgePathCache.clear();
    edgeSpatialGrid.clear();
    clearRemovalGhosts();
    surface.replaceChildren();
    clearActiveEdges();
    context.clearRect(0, 0, edgesCanvas.width, edgesCanvas.height);
    return true;
  }

  return Object.freeze({
    activate,
    suspend,
    dispose,
    getViewState,
    getVisibleWorldRect: visibleWorldRect,
    setModel,
    createNodeOfType: createTypedNode,
    createNodeWithOptions: (options = {}, worldPoint = null) => {
      const rect = viewportRect();
      const point = worldPoint || screenToWorld({ x: rect.width / 2, y: rect.height / 2 });
      return createNodeAt(point, { ...options, edit: false });
    },
    getConnectionKind,
    getCreationTool,
    getSelectedNode: () => selectedNodeIds.size === 1 ? model.node(Array.from(selectedNodeIds)[0]) : null,
    getSelection: () => ({ nodeIds: Array.from(selectedNodeIds), edgeIds: Array.from(selectedEdgeIds) }),
    duplicateSelection,
    clearSelection,
    selectNodes,
    focusNodes,
    setConnectionKind,
    setCreationTool,
    setComputeProjection,
    centerOrigin,
    resetInteractionPreferences,
  });
}

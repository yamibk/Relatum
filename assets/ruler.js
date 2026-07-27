(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.RelatumRuler = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';

  const LENGTH = 720;
  const WIDTH = 52;
  const EDGE_CAPTURE_PX = 14;
  const CONTACT_CLEARANCE_PX = 1.5;

  function finite(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }

  function normalizeAngle(value) {
    const number = finite(value);
    if (number === null) return 0;
    return ((number % 360) + 360) % 360;
  }

  function normalize(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const cx = finite(raw.cx);
    const cy = finite(raw.cy);
    if (cx === null || cy === null) return null;
    return { cx: cx, cy: cy, angle: normalizeAngle(raw.angle) };
  }

  function clone(raw) {
    const ruler = normalize(raw);
    return ruler ? { cx: ruler.cx, cy: ruler.cy, angle: ruler.angle } : null;
  }

  function basis(raw) {
    const ruler = normalize(raw) || { cx: 0, cy: 0, angle: 0 };
    const radians = ruler.angle * Math.PI / 180;
    const tangent = { x: Math.cos(radians), y: Math.sin(radians) };
    const normal = { x: -tangent.y, y: tangent.x };
    return { ruler: ruler, tangent: tangent, normal: normal };
  }

  function pointToLocal(point, raw) {
    const frame = basis(raw);
    const dx = (Number(point && point.x) || 0) - frame.ruler.cx;
    const dy = (Number(point && point.y) || 0) - frame.ruler.cy;
    return {
      x: dx * frame.tangent.x + dy * frame.tangent.y,
      y: dx * frame.normal.x + dy * frame.normal.y,
    };
  }

  function pointFromLocal(point, raw) {
    const frame = basis(raw);
    const x = Number(point && point.x) || 0;
    const y = Number(point && point.y) || 0;
    return {
      x: frame.ruler.cx + x * frame.tangent.x + y * frame.normal.x,
      y: frame.ruler.cy + x * frame.tangent.y + y * frame.normal.y,
    };
  }

  function containsPoint(point, raw, options) {
    const ruler = normalize(raw);
    if (!ruler) return false;
    const opts = options || {};
    const scale = Math.max(0.25, Number(opts.scale) || 1);
    const requestedPadding = Number(opts.paddingPx);
    const padding = (Number.isFinite(requestedPadding) ? Math.max(0, requestedPadding) : 0) / scale;
    const local = pointToLocal(point, ruler);
    return Math.abs(local.x) <= LENGTH / 2 + padding
      && Math.abs(local.y) <= WIDTH / 2 + padding;
  }

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function nearestEdge(point, raw, options) {
    const ruler = normalize(raw);
    if (!ruler) return null;
    const opts = options || {};
    const scale = Math.max(0.25, Number(opts.scale) || 1);
    const threshold = Math.max(0, Number(opts.capturePx) || EDGE_CAPTURE_PX) / scale;
    const local = pointToLocal(point, ruler);
    const halfLength = LENGTH / 2;
    const halfWidth = WIDTH / 2;
    const positiveDistance = Math.abs(local.y - halfWidth);
    const negativeDistance = Math.abs(local.y + halfWidth);
    const edgeSign = positiveDistance <= negativeDistance ? 1 : -1;
    const distance = Math.min(positiveDistance, negativeDistance);
    if (distance > threshold || Math.abs(local.x) > halfLength + threshold) return null;
    return {
      edgeSign: edgeSign,
      distance: distance,
      point: pointFromLocal({
        x: clamp(local.x, -halfLength, halfLength),
        y: edgeSign * halfWidth,
      }, ruler),
    };
  }

  function projectPointToEdge(point, raw, edgeSign) {
    const ruler = normalize(raw);
    if (!ruler) return null;
    const local = pointToLocal(point, ruler);
    return pointFromLocal({
      x: clamp(local.x, -LENGTH / 2, LENGTH / 2),
      y: (edgeSign < 0 ? -1 : 1) * WIDTH / 2,
    }, ruler);
  }

  function segmentRectEntry(from, to, minX, maxX, minY, maxY) {
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    let enter = 0;
    let exit = 1;

    function clipAxis(start, delta, min, max) {
      if (Math.abs(delta) < 1e-12) return start >= min && start <= max;
      let first = (min - start) / delta;
      let second = (max - start) / delta;
      if (first > second) {
        const swap = first;
        first = second;
        second = swap;
      }
      enter = Math.max(enter, first);
      exit = Math.min(exit, second);
      return enter <= exit;
    }

    if (!clipAxis(from.x, dx, minX, maxX)) return null;
    if (!clipAxis(from.y, dy, minY, maxY)) return null;
    if (exit < 0 || enter > 1) return null;
    return clamp(enter, 0, 1);
  }

  // Find the first point where a confirmed pointer segment enters either long
  // edge's screen-pixel capture band. This complements nearestEdge(): fast
  // pointer movement cannot skip the ruler just because no sampled endpoint
  // happened to land inside the band.
  function captureEdgeAlongSegment(from, to, raw, options) {
    const ruler = normalize(raw);
    if (!ruler || !from || !to) return null;
    const fromX = finite(from && from.x);
    const fromY = finite(from && from.y);
    const toX = finite(to && to.x);
    const toY = finite(to && to.y);
    if (fromX === null || fromY === null || toX === null || toY === null) return null;
    const opts = options || {};
    const scale = Math.max(0.25, Number(opts.scale) || 1);
    const requestedCapture = Number(opts.capturePx);
    const capturePx = Number.isFinite(requestedCapture)
      ? Math.max(0, requestedCapture)
      : EDGE_CAPTURE_PX;
    const threshold = capturePx / scale;
    const localFrom = pointToLocal({ x: fromX, y: fromY }, ruler);
    const localTo = pointToLocal({ x: toX, y: toY }, ruler);
    const halfLength = LENGTH / 2;
    const halfWidth = WIDTH / 2;
    let earliest = null;

    [-1, 1].forEach(function (edgeSign) {
      const edgeY = edgeSign * halfWidth;
      const time = segmentRectEntry(
        localFrom,
        localTo,
        -halfLength - threshold,
        halfLength + threshold,
        edgeY - threshold,
        edgeY + threshold,
      );
      if (time === null) return;
      const x = localFrom.x + (localTo.x - localFrom.x) * time;
      const y = localFrom.y + (localTo.y - localFrom.y) * time;
      const distance = Math.abs(y - edgeY);
      if (!earliest
          || time < earliest.time - 1e-9
          || (Math.abs(time - earliest.time) <= 1e-9 && distance < earliest.distance)) {
        earliest = {
          edgeSign: edgeSign,
          time: time,
          distance: distance,
          point: pointFromLocal({
            x: clamp(x, -halfLength, halfLength),
            y: edgeY,
          }, ruler),
        };
      }
    });

    return earliest;
  }

  function rectProjection(rect, frame) {
    const width = Math.max(0, Number(rect && rect.w) || 0);
    const height = Math.max(0, Number(rect && rect.h) || 0);
    const cx = (Number(rect && rect.x) || 0) + width / 2;
    const cy = (Number(rect && rect.y) || 0) + height / 2;
    const dx = cx - frame.ruler.cx;
    const dy = cy - frame.ruler.cy;
    return {
      tangent: dx * frame.tangent.x + dy * frame.tangent.y,
      normal: dx * frame.normal.x + dy * frame.normal.y,
      tangentRadius: Math.abs(frame.tangent.x) * width / 2 + Math.abs(frame.tangent.y) * height / 2,
      normalRadius: Math.abs(frame.normal.x) * width / 2 + Math.abs(frame.normal.y) * height / 2,
    };
  }

  function rectIntersects(rawRect, rawRuler, options) {
    const ruler = normalize(rawRuler);
    if (!ruler) return false;
    const scale = Math.max(0.25, Number(options && options.scale) || 1);
    const requestedClearance = Number(options && options.clearancePx);
    const clearancePx = Number.isFinite(requestedClearance)
      ? Math.max(0, requestedClearance)
      : CONTACT_CLEARANCE_PX;
    const clearance = clearancePx / scale;
    const frame = basis(ruler);
    const projected = rectProjection(rawRect, frame);
    return Math.abs(projected.tangent) <= LENGTH / 2 + projected.tangentRadius
      && Math.abs(projected.normal) <= WIDTH / 2 + projected.normalRadius + clearance;
  }

  function canConstrainSelection(rects, rawRuler, options) {
    const ruler = normalize(rawRuler);
    if (!ruler || !Array.isArray(rects) || !rects.length) return false;
    const frame = basis(ruler);
    let side = 0;
    for (let index = 0; index < rects.length; index += 1) {
      const physicalOptions = Object.assign({}, options || {}, { clearancePx: 0 });
      if (rectIntersects(rects[index], ruler, physicalOptions)) return false;
      const projected = rectProjection(rects[index], frame);
      const nextSide = projected.normal < 0 ? -1 : 1;
      if (side && side !== nextSide) return false;
      side = nextSide;
    }
    return true;
  }

  // Sweep the selected axis-aligned node rectangles against the ruler's two long
  // edges. The earliest long-edge contact clamps only the normal component, so
  // the pointer can continue sliding the selection along the ruler.
  function constrainTranslation(rects, rawRuler, dx, dy, options) {
    const ruler = normalize(rawRuler);
    const nextDX = Number(dx) || 0;
    const nextDY = Number(dy) || 0;
    if (!ruler || !Array.isArray(rects) || !rects.length) {
      return { dx: nextDX, dy: nextDY, collided: false };
    }
    const scale = Math.max(0.25, Number(options && options.scale) || 1);
    const clearance = CONTACT_CLEARANCE_PX / scale;
    const frame = basis(ruler);
    const tangentDelta = nextDX * frame.tangent.x + nextDY * frame.tangent.y;
    const normalDelta = nextDX * frame.normal.x + nextDY * frame.normal.y;
    let earliest = null;

    rects.forEach(function (rect) {
      const projected = rectProjection(rect, frame);
      const side = projected.normal < 0 ? -1 : 1;
      const signedStart = side * projected.normal;
      const signedDelta = side * normalDelta;
      const physicalLimit = WIDTH / 2 + projected.normalRadius;
      const limit = WIDTH / 2 + projected.normalRadius + clearance;
      if (signedStart < physicalLimit || signedDelta >= 0 || signedStart + signedDelta >= limit) return;
      const time = (limit - signedStart) / signedDelta;
      if (!(time >= 0 && time <= 1)) return;
      const tangentAtContact = projected.tangent + tangentDelta * time;
      if (Math.abs(tangentAtContact) > LENGTH / 2 + projected.tangentRadius) return;
      if (!earliest || time < earliest.time) {
        earliest = {
          time: time,
          allowedNormalDelta: side * (limit - signedStart),
        };
      }
    });

    if (!earliest) return { dx: nextDX, dy: nextDY, collided: false };
    return {
      dx: frame.tangent.x * tangentDelta + frame.normal.x * earliest.allowedNormalDelta,
      dy: frame.tangent.y * tangentDelta + frame.normal.y * earliest.allowedNormalDelta,
      collided: true,
      time: earliest.time,
    };
  }

  return {
    LENGTH: LENGTH,
    WIDTH: WIDTH,
    EDGE_CAPTURE_PX: EDGE_CAPTURE_PX,
    normalizeAngle: normalizeAngle,
    normalize: normalize,
    clone: clone,
    basis: basis,
    pointToLocal: pointToLocal,
    pointFromLocal: pointFromLocal,
    containsPoint: containsPoint,
    nearestEdge: nearestEdge,
    projectPointToEdge: projectPointToEdge,
    captureEdgeAlongSegment: captureEdgeAlongSegment,
    rectIntersects: rectIntersects,
    canConstrainSelection: canConstrainSelection,
    constrainTranslation: constrainTranslation,
  };
});

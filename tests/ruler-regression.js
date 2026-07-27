const assert = require('assert');
const rulerGeometry = require('../assets/ruler.js');

function close(actual, expected, epsilon = 0.001) {
  assert(Math.abs(actual - expected) <= epsilon, `${actual} should be close to ${expected}`);
}

function rectFromCenter(cx, cy, w, h) {
  return { x: cx - w / 2, y: cy - h / 2, w, h };
}

assert.deepStrictEqual(rulerGeometry.normalize({ cx: 12, cy: -8, angle: -65 }), {
  cx: 12,
  cy: -8,
  angle: 295,
});
assert.strictEqual(rulerGeometry.normalize({ cx: 'bad', cy: 0, angle: 0 }), null);

const horizontal = { cx: 0, cy: 0, angle: 0 };
const topNode = rectFromCenter(0, 80, 100, 40);
assert.strictEqual(rulerGeometry.canConstrainSelection([topNode], horizontal), true);
const topHit = rulerGeometry.constrainTranslation([topNode], horizontal, 120, -300);
assert.strictEqual(topHit.collided, true);
close(topHit.dx, 120);
close(topHit.dy, -32.5);

// A node resting at the visual clearance remains constrained on its next drag;
// contact is not mistaken for a pre-existing physical overlap.
const restingTop = Object.assign({}, topNode, { x: topNode.x + topHit.dx, y: topNode.y + topHit.dy });
assert.strictEqual(rulerGeometry.canConstrainSelection([restingTop], horizontal), true);
const restingSlide = rulerGeometry.constrainTranslation([restingTop], horizontal, 95, -80);
assert.strictEqual(restingSlide.collided, true);
close(restingSlide.dx, 95);
close(restingSlide.dy, 0);

const bottomNode = rectFromCenter(0, -80, 100, 40);
const bottomHit = rulerGeometry.constrainTranslation([bottomNode], horizontal, -45, 300);
assert.strictEqual(bottomHit.collided, true);
close(bottomHit.dx, -45);
close(bottomHit.dy, 32.5);

// A fast pointer jump still stops at the same long edge.
const fastHit = rulerGeometry.constrainTranslation([topNode], horizontal, 0, -5000);
assert.strictEqual(fastHit.collided, true);
close(fastHit.dy, -32.5);

// Past the finite end of the ruler, the same normal movement is allowed.
const beyondEnd = rectFromCenter(480, 80, 100, 40);
const endPass = rulerGeometry.constrainTranslation([beyondEnd], horizontal, 0, -300);
assert.strictEqual(endPass.collided, false);
close(endPass.dy, -300);

// Multi-selection uses the earliest contacting member and preserves one shared delta.
const upperNode = rectFromCenter(20, 120, 90, 36);
const lowerNode = rectFromCenter(-40, 70, 90, 36);
const multiHit = rulerGeometry.constrainTranslation([upperNode, lowerNode], horizontal, 75, -180);
assert.strictEqual(multiHit.collided, true);
close(multiHit.dx, 75);
close(multiHit.dy, -24.5);

const overlapping = rectFromCenter(0, 30, 100, 40);
assert.strictEqual(rulerGeometry.canConstrainSelection([overlapping], horizontal), false);
assert.strictEqual(rulerGeometry.canConstrainSelection([topNode, bottomNode], horizontal), false);

const vertical = { cx: 0, cy: 0, angle: 90 };
const rightNode = rectFromCenter(90, 0, 40, 100);
const verticalHit = rulerGeometry.constrainTranslation([rightNode], vertical, -300, 25);
assert.strictEqual(verticalHit.collided, true);
close(verticalHit.dx, -42.5);
close(verticalHit.dy, 25);

const angled = { cx: 100, cy: -40, angle: 65 };
[
  { ruler: horizontal, local: { x: 0, y: 0 } },
  { ruler: vertical, local: { x: 220, y: 20 } },
  { ruler: angled, local: { x: -310, y: -24 } },
].forEach(({ ruler, local }) => {
  assert.strictEqual(
    rulerGeometry.containsPoint(rulerGeometry.pointFromLocal(local, ruler), ruler),
    true,
  );
});
const outsideAngledEnd = rulerGeometry.pointFromLocal(
  { x: rulerGeometry.LENGTH / 2 + 12, y: 0 },
  angled,
);
assert.strictEqual(rulerGeometry.containsPoint(outsideAngledEnd, angled), false);
assert.strictEqual(
  rulerGeometry.containsPoint(outsideAngledEnd, angled, { scale: 0.25, paddingPx: 4 }),
  true,
);
assert.strictEqual(
  rulerGeometry.containsPoint(outsideAngledEnd, angled, { scale: 1, paddingPx: 4 }),
  false,
);
assert.strictEqual(
  rulerGeometry.containsPoint(outsideAngledEnd, angled, { scale: 4, paddingPx: 4 }),
  false,
);

const nearEdgeWorld = rulerGeometry.pointFromLocal({ x: 110, y: rulerGeometry.WIDTH / 2 + 7 }, angled);
const captured = rulerGeometry.nearestEdge(nearEdgeWorld, angled, { scale: 1 });
assert(captured);
assert.strictEqual(captured.edgeSign, 1);
const capturedLocal = rulerGeometry.pointToLocal(captured.point, angled);
close(capturedLocal.x, 110);
close(capturedLocal.y, rulerGeometry.WIDTH / 2);

const projected = rulerGeometry.projectPointToEdge(
  rulerGeometry.pointFromLocal({ x: 900, y: -200 }, angled),
  angled,
  -1,
);
const projectedLocal = rulerGeometry.pointToLocal(projected, angled);
close(projectedLocal.x, rulerGeometry.LENGTH / 2);
close(projectedLocal.y, -rulerGeometry.WIDTH / 2);

// A confirmed pointer segment can acquire a ruler edge after the stroke began
// elsewhere. The first long-edge capture band wins, even for a fast crossing.
const fastTopCapture = rulerGeometry.captureEdgeAlongSegment(
  rulerGeometry.pointFromLocal({ x: 40, y: 100 }, horizontal),
  rulerGeometry.pointFromLocal({ x: 40, y: -100 }, horizontal),
  horizontal,
  { scale: 1 },
);
assert(fastTopCapture);
assert.strictEqual(fastTopCapture.edgeSign, 1);
close(fastTopCapture.time, 0.3);
const fastTopLocal = rulerGeometry.pointToLocal(fastTopCapture.point, horizontal);
close(fastTopLocal.x, 40);
close(fastTopLocal.y, rulerGeometry.WIDTH / 2);

const fastBottomCapture = rulerGeometry.captureEdgeAlongSegment(
  rulerGeometry.pointFromLocal({ x: -75, y: -100 }, horizontal),
  rulerGeometry.pointFromLocal({ x: -75, y: 100 }, horizontal),
  horizontal,
  { scale: 1 },
);
assert(fastBottomCapture);
assert.strictEqual(fastBottomCapture.edgeSign, -1);
close(fastBottomCapture.time, 0.3);

// Rotation does not change the local entry point or edge choice.
const angledCapture = rulerGeometry.captureEdgeAlongSegment(
  rulerGeometry.pointFromLocal({ x: 125, y: 90 }, angled),
  rulerGeometry.pointFromLocal({ x: 125, y: 20 }, angled),
  angled,
  { scale: 1 },
);
assert(angledCapture);
assert.strictEqual(angledCapture.edgeSign, 1);
const angledCaptureLocal = rulerGeometry.pointToLocal(angledCapture.point, angled);
close(angledCaptureLocal.x, 125);
close(angledCaptureLocal.y, rulerGeometry.WIDTH / 2);

// Capture remains a fixed screen-pixel distance across zoom levels.
const quarterScaleCapture = rulerGeometry.captureEdgeAlongSegment(
  rulerGeometry.pointFromLocal({ x: 0, y: 100 }, vertical),
  rulerGeometry.pointFromLocal({ x: 0, y: 80 }, vertical),
  vertical,
  { scale: 0.25 },
);
assert(quarterScaleCapture);
close(rulerGeometry.pointToLocal(quarterScaleCapture.point, vertical).y, rulerGeometry.WIDTH / 2);
assert.strictEqual(
  rulerGeometry.captureEdgeAlongSegment(
    rulerGeometry.pointFromLocal({ x: 0, y: 100 }, vertical),
    rulerGeometry.pointFromLocal({ x: 0, y: 80 }, vertical),
    vertical,
    { scale: 1 },
  ),
  null,
);
const fourScaleCapture = rulerGeometry.captureEdgeAlongSegment(
  rulerGeometry.pointFromLocal({ x: 0, y: 40 }, vertical),
  rulerGeometry.pointFromLocal({ x: 0, y: 29 }, vertical),
  vertical,
  { scale: 4 },
);
assert(fourScaleCapture);

// The capture band is finite: approaching the short end can hit, but a
// parallel segment beyond its padded endpoint cannot acquire the ruler.
const endCapture = rulerGeometry.captureEdgeAlongSegment(
  rulerGeometry.pointFromLocal({ x: 430, y: rulerGeometry.WIDTH / 2 }, horizontal),
  rulerGeometry.pointFromLocal({ x: 350, y: rulerGeometry.WIDTH / 2 }, horizontal),
  horizontal,
  { scale: 1 },
);
assert(endCapture);
close(rulerGeometry.pointToLocal(endCapture.point, horizontal).x, rulerGeometry.LENGTH / 2);
assert.strictEqual(
  rulerGeometry.captureEdgeAlongSegment(
    rulerGeometry.pointFromLocal({ x: 430, y: 100 }, horizontal),
    rulerGeometry.pointFromLocal({ x: 430, y: 0 }, horizontal),
    horizontal,
    { scale: 1 },
  ),
  null,
);
assert.strictEqual(
  rulerGeometry.captureEdgeAlongSegment(
    rulerGeometry.pointFromLocal({ x: -200, y: 0 }, horizontal),
    rulerGeometry.pointFromLocal({ x: 200, y: 0 }, horizontal),
    horizontal,
    { scale: 1 },
  ),
  null,
);
assert.strictEqual(
  rulerGeometry.captureEdgeAlongSegment(null, { x: 0, y: 0 }, horizontal),
  null,
);

const tooFarFromEdge = rulerGeometry.pointFromLocal({ x: 0, y: rulerGeometry.WIDTH / 2 + 30 }, angled);
assert.strictEqual(rulerGeometry.nearestEdge(tooFarFromEdge, angled, { scale: 1 }), null);
const pastCaptureEnd = rulerGeometry.pointFromLocal({ x: rulerGeometry.LENGTH / 2 + 40, y: rulerGeometry.WIDTH / 2 }, angled);
assert.strictEqual(rulerGeometry.nearestEdge(pastCaptureEnd, angled, { scale: 1 }), null);

// A 65-degree obstacle must still constrain an axis-aligned node crossing its normal.
const frame = rulerGeometry.basis(angled);
const angledStart = rulerGeometry.pointFromLocal({ x: 0, y: 120 }, angled);
const angledRect = rectFromCenter(angledStart.x, angledStart.y, 80, 44);
const angledDelta = { x: frame.normal.x * -300, y: frame.normal.y * -300 };
const angledHit = rulerGeometry.constrainTranslation(
  [angledRect],
  angled,
  angledDelta.x,
  angledDelta.y,
);
assert.strictEqual(angledHit.collided, true);

console.log('ruler regression tests passed');

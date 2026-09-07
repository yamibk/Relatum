'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function functionSource(source, name) {
  const start = source.indexOf('  function ' + name + '(');
  assert(start >= 0, 'missing function ' + name);
  const end = source.indexOf('\n  function ', start + 5);
  assert(end > start, 'missing boundary after ' + name);
  return source.slice(start, end);
}

function harness(source, visual) {
  let now = 100, nextId = 1, renders = 0;
  const frames = new Map();
  const gesture = { id: 1, active: true, latestX: 1439, latestY: 450 };
  const context = {
    viewport: { getBoundingClientRect: () => ({ left: 0, top: 0, right: 1440, bottom: 900 }) },
    view: { x: 0, y: 0, zoom: 1 },
    drag: visual ? null : gesture, dragFrame: 0,
    visualLinkDrag: visual ? gesture : null, visualLinkFrame: 0,
    stopViewAnimation() {}, applyView() { renders++; },
    positionDraggedSubtree() {}, updateDragCandidate() {}, updateVisualLinkPreview() {},
    performance: { now: () => now },
    requestAnimationFrame(callback) { const id = nextId++; frames.set(id, callback); return id; },
    finishDrag() { context.drag = null; frames.clear(); },
    finishVisualLinkDrag() { context.visualLinkDrag = null; frames.clear(); },
  };
  vm.createContext(context);
  const flush = visual ? 'flushVisualLinkFrame' : 'flushDragFrame';
  const move = visual ? 'onVisualLinkMove' : 'onDragMove';
  vm.runInContext(['autoPanDrag', flush, move].map(name => functionSource(source, name)).join('\n'), context);
  return {
    context, frames, gesture,
    move(x, y = 450) {
      context[move]({ pointerId: 1, clientX: x, clientY: y, buttons: visual ? 2 : 1, preventDefault() {} });
    },
    frame(timestamp) {
      now = timestamp;
      const callbacks = Array.from(frames.values());
      frames.clear();
      callbacks.forEach(callback => callback(timestamp));
    },
    setTime(timestamp) { now = timestamp; },
    get renders() { return renders; },
  };
}

for (const file of ['study-route.js', 'tree-page.js']) {
  const source = fs.readFileSync(path.join(__dirname, '..', 'assets', file), 'utf8');
  for (const visual of file === 'tree-page.js' ? [false, true] : [false]) {
    const label = file + (visual ? ' visual link' : ' subtree');
    for (const hz of [60, 120, 144, 240]) {
      for (const side of [-1, 1]) {
        const test = harness(source, visual);
        test.move(side > 0 ? 1439 : 1);
        for (let i = 1; i <= hz; i++) test.frame(100 + i * 1000 / hz);
        assert(Math.abs(test.context.view.x + side * 594) < 1e-7,
          `${label}: ${hz}Hz must retain 594px/s at this edge position`);
        assert.equal(test.renders, hz, label + ': every display frame remains available');
        // Leave the edge without releasing the gesture. The loop must stop.
        test.move(720);
        test.frame(1100 + 1000 / hz);
        assert.equal(test.frames.size, 0, label + ': no animation loop away from the edge');
        const x = test.context.view.x;
        // A long idle pointer pause must not turn into a large jump on reentry.
        test.setTime(10000);
        test.move(1439);
        test.frame(10000 + 1000 / hz);
        assert(Math.abs(test.context.view.x - x + 594 / hz) < 1e-7, label + ': reentry resets elapsed time');
      }
    }
    const slow = harness(source, visual);
    slow.move(1439, 899);
    slow.frame(4100);
    assert(Math.abs(slow.context.view.x + 23.76) < 1e-7, label + ': delayed frame is capped at 40ms');
    assert(Math.abs(slow.context.view.y + 23.76) < 1e-7, label + ': vertical speed uses the same clock');
    const negative = harness(source, visual);
    negative.move(1439);
    negative.frame(99);
    assert.equal(negative.context.view.x, 0, label + ': stale timestamp cannot reverse motion');
    console.log(label + ': 60/120/144/240Hz, edge exit/reentry, delayed frame and vertical motion passed');
  }
}

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

// Exercise the bundled selection renderer with measured line coordinates.
// No browser, synthetic pointer events or alternative selection implementation.
const source = fs.readFileSync(path.join(__dirname, '..', 'assets', 'vendor', 'codemirror', 'relatum-codemirror.min.js'), 'utf8');
const exportPoint = /return [\w$]+\([\w$]+\);(?=\}\)\(\);?\s*$)/.exec(source)?.[0];
assert(exportPoint, 'the offline bundle must expose the test probe at its final export');
const methodAt = source.indexOf('static forRange(');
const selectionClass = [...source.slice(0, methodAt).matchAll(/(?:var |,)([\w$]+)=class\s+[\w$]*\{/g)].at(-1)?.[1];
assert(selectionClass, 'the actual bundled selection rectangle class must be discoverable');
const context = {};
vm.runInNewContext(source.replace(exportPoint,
  'globalThis.__selectionForRange = ' + selectionClass + '.forRange;' + exportPoint), context);
context.window = { getComputedStyle: (line) => line.style };
const CM = context.RelatumCodeMirror;
const probe = { forRange: context.__selectionForRange, Text: CM.BlockType.Text, LTR: CM.Direction.LTR };

function measureSelection({ firstCallout = true, sourceMode = false, reverse = false, wrapping = true, baseline = false, calloutOnly = false, trailingLineBreak = false } = {}) {
  const doc = CM.EditorState.create({ doc: calloutOnly
    ? '> [!note]\n> 12\n> 2\n> 23333333333333'
    : '> [!note]\n> Callout 正文。\n\n' + (trailingLineBreak ? '12\n23333333\n33\n' : '12\n2\n23333333333333') }).doc;
  const firstSelected = calloutOnly ? 2 : 4, lastSelected = calloutOnly ? 4 : trailingLineBreak ? 7 : 6;
  const from = doc.line(firstSelected).from + (calloutOnly && !sourceMode ? 2 : 0), to = doc.line(lastSelected).to;
  const range = CM.EditorSelection.range(reverse ? to : from, reverse ? from : to);
  const ordinary = { style: { paddingLeft: '0px', paddingRight: '0px', textIndent: '0px' } };
  const callout = { style: { paddingLeft: '24px', paddingRight: '12px', textIndent: '0px' } };
  const contentRect = { left: 100, right: 900, top: 0 };
  const scrollRect = { left: 20, right: 980, top: 40 };
  const origin = { left: scrollRect.left - 7, top: scrollRect.top - 13 };
  const first = firstCallout && !sourceMode ? callout : ordinary;
  const querySelector = (selector) => {
    if (baseline || selector === '.cm-line') return first;
    assert.strictEqual(selector, '.cm-line:not(.note-live-callout-line)');
    return calloutOnly && first === callout ? null : ordinary;
  };
  const top = (line) => 120 + (line.number - 1) * 26.4;
  const view = {
    state: { doc }, viewport: { from: 0, to: doc.length },
    visibleRanges: [{ from: 0, to: doc.length }],
    textDirection: probe.LTR, lineWrapping: wrapping, defaultLineHeight: 26.4,
    scaleX: 1, scaleY: 1,
    contentDOM: { getBoundingClientRect: () => contentRect, querySelector },
    dom: { getBoundingClientRect: () => ({ left: 0, right: 1000 }) },
    scrollDOM: { getBoundingClientRect: () => scrollRect, clientWidth: 960, scrollLeft: 7, scrollTop: 13 },
    lineBlockAt(position) {
      const line = doc.lineAt(position);
      return { from: line.from, to: line.to, top: top(line), bottom: top(line) + 26.4, type: probe.Text, widgetLineBreaks: 0 };
    },
    coordsAtPos(position) {
      const line = doc.lineAt(position);
      const inCallout = first === callout && (calloutOnly || line.number <= 2);
      const left = contentRect.left + (inCallout ? 24 : 0) + Math.max(0, position - line.from - (inCallout ? 2 : 0)) * 8;
      return { left, right: left, top: top(line), bottom: top(line) + 20 };
    },
    posAtCoords({ x, y }) {
      const number = Math.max(1, Math.min(doc.lines, Math.floor((y - 120) / 26.4) + 1));
      const line = doc.line(number);
      return x < contentRect.left ? line.from + (first === callout && calloutOnly ? 2 : 0) : line.to;
    },
    bidiSpans(line) { return [{ from: 0, to: line.length, dir: probe.LTR }]; },
    elementAtHeight() { return { type: probe.Text }; },
  };
  const rectangles = Array.from(probe.forRange(view, 'cm-selectionBackground', range), (rect) => ({
    left: rect.left, top: rect.top, width: rect.width, height: rect.height,
  }));
  return { rectangles, copied: doc.sliceString(range.from, range.to), range, origin,
    firstTop: top(doc.line(firstSelected)), lastTop: top(doc.line(lastSelected)) };
}

// Preserve a reproduction of the upstream first-line-padding assumption.
const baseline = measureSelection({ baseline: true });
assert.strictEqual(baseline.rectangles[1].left + baseline.origin.left, 124,
  'a leading Callout formerly left a 24px unhighlighted strip on selected ordinary lines');
assert.strictEqual(baseline.rectangles[1].width, 764,
  'a leading Callout formerly removed its two horizontal insets from ordinary selection fill');

const fixed = measureSelection();
assert.strictEqual(fixed.copied, '12\n2\n23333333333333', 'copy must continue using the unchanged source range');
assert.strictEqual(fixed.range.from, baseline.range.from);
assert.strictEqual(fixed.range.to, baseline.range.to);
assert.strictEqual(fixed.rectangles.length, 3, 'selection must retain the first, intervening and final line rectangles');
assert.strictEqual(fixed.rectangles[1].left + fixed.origin.left, 100,
  'selected ordinary lines below a Callout must fill from the real text-column left edge');
assert.strictEqual(fixed.rectangles[1].width, 800,
  'selected ordinary lines must retain the full text-column fill width');
assert.strictEqual(fixed.rectangles[0].top + fixed.origin.top, fixed.firstTop);
assert.strictEqual(fixed.rectangles[2].top + fixed.origin.top, fixed.lastTop);
assert.strictEqual(fixed.rectangles[2].width, fixed.copied.split('\n')[2].length * 8,
  'the final rectangle must end at the actual selected text position');
assert.deepStrictEqual(measureSelection({ reverse: true }).rectangles, fixed.rectangles,
  'forward and reverse selections must use identical geometry');
assert.deepStrictEqual(measureSelection({ firstCallout: false }).rectangles, fixed.rectangles,
  'ordinary first lines must retain the original geometry');
assert.deepStrictEqual(measureSelection({ sourceMode: true }).rectangles, fixed.rectangles,
  'source-mode lines without Callout decorations must retain the original geometry');
assert.deepStrictEqual(measureSelection({ wrapping: false }).rectangles, fixed.rectangles,
  'the padding correction must not depend on visual-line wrapping');

// Dragging through a final newline makes the short final text row part of
// the full-width middle rectangle. The old 24px inset hid all its glyphs,
// which looked like a missing selected row despite correct copied text.
const oldThroughNewline = measureSelection({ baseline: true, trailingLineBreak: true });
const throughNewline = measureSelection({ trailingLineBreak: true });
assert.strictEqual(throughNewline.copied, '12\n23333333\n33\n');
assert.strictEqual(oldThroughNewline.copied, throughNewline.copied);
assert(oldThroughNewline.rectangles[1].left + oldThroughNewline.origin.left > 100 + 2 * 8,
  'the old Callout inset completely missed a two-character final selected row');
const middle = throughNewline.rectangles[1];
assert.strictEqual(middle.left + throughNewline.origin.left, 100);
assert(middle.left + middle.width + throughNewline.origin.left >= 100 + 2 * 8);
assert(middle.top + throughNewline.origin.top < 120 + 5 * 26.4
  && middle.top + middle.height + throughNewline.origin.top >= 120 + 5 * 26.4 + 20,
  'the middle fill must cover the entire short final selected row, including its actual vertical bounds');
assert.deepStrictEqual(measureSelection({ trailingLineBreak: true, reverse: true }).rectangles, throughNewline.rectangles);

const cardOnly = measureSelection({ calloutOnly: true });
assert.strictEqual(cardOnly.rectangles[1].left + cardOnly.origin.left, 100);
assert.strictEqual(cardOnly.rectangles[1].width, 800,
  'a viewport containing only Callout lines must safely fall back to content bounds');
assert.strictEqual(cardOnly.rectangles[0].left + cardOnly.origin.left, 124,
  'partial Callout selections must still start at the measured, padded text position');
assert.strictEqual(cardOnly.rectangles[2].left + cardOnly.rectangles[2].width + cardOnly.origin.left, 124 + 14 * 8,
  'partial Callout selections must still end at the measured text position');
assert.deepStrictEqual(measureSelection({ calloutOnly: true, reverse: true }).rectangles, cardOnly.rectangles);

console.log('note Callout selection regression: ok');

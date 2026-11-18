// Relatum 结构化行内富文本
//
// 真实内容始终是纯文字；字号、字色、高光与粗体保存在不重叠的 marks 区间中。
// 旧 {hl:...|...} / {tc:...|...} / {fs:...|...} / ==...== / **...**
// 只在载入兼容和 Markdown 输出边界出现，正常编辑面不再暴露这些定界符。
(function (global) {
  'use strict';

  const TEXT_COLORS = new Set(['yellow', 'orange', 'red', 'purple', 'blue', 'cyan', 'green', 'gray', 'white']);
  const HIGHLIGHT_COLORS = new Set(['yellow', 'orange', 'red', 'purple', 'blue', 'cyan', 'green', 'gray']);
  const SIZES = new Set(['sm', 'lg', 'xl']);
  const STYLE_KEYS = ['size', 'color', 'highlight', 'bold'];

  function cleanStyle(raw) {
    const out = {};
    if (!raw || typeof raw !== 'object') return out;
    if (SIZES.has(raw.size)) out.size = raw.size;
    if (TEXT_COLORS.has(raw.color)) out.color = raw.color;
    if (HIGHLIGHT_COLORS.has(raw.highlight)) out.highlight = raw.highlight;
    if (raw.bold === true) out.bold = true;
    return out;
  }

  function hasStyle(style) {
    return !!(style && (style.size || style.color || style.highlight || style.bold));
  }

  function sameStyle(a, b) {
    return STYLE_KEYS.every(function (key) { return (a && a[key]) === (b && b[key]); });
  }

  function normalizedMark(raw, textLength) {
    if (!raw || typeof raw !== 'object') return null;
    const start = Math.max(0, Math.min(textLength, Math.floor(Number(raw.start)) || 0));
    const end = Math.max(start, Math.min(textLength, Math.floor(Number(raw.end)) || 0));
    const style = cleanStyle(raw.style || raw);
    if (end <= start || !hasStyle(style)) return null;
    return Object.assign({ start: start, end: end }, style);
  }

  function styleAt(marks, pos) {
    const out = {};
    for (let i = 0; i < marks.length; i++) {
      const mark = marks[i];
      if (pos >= mark.start && pos < mark.end) {
        STYLE_KEYS.forEach(function (key) {
          if (mark[key] != null) out[key] = mark[key];
        });
      }
    }
    return out;
  }

  // normalize() 的输出始终按位置排序且互不重叠；后续编辑路径可二分定位，
  // 避免每个区间都从头扫描全部 marks。
  function styleAtNormalized(marks, pos) {
    let low = 0;
    let high = marks.length - 1;
    while (low <= high) {
      const mid = (low + high) >> 1;
      const mark = marks[mid];
      if (pos < mark.start) high = mid - 1;
      else if (pos >= mark.end) low = mid + 1;
      else return cleanStyle(mark);
    }
    return {};
  }

  function normalize(text, rawMarks) {
    text = String(text == null ? '' : text);
    const length = text.length;
    const marks = Array.isArray(rawMarks)
      ? rawMarks.map(function (mark) { return normalizedMark(mark, length); }).filter(Boolean)
      : [];
    if (!marks.length || !length) return [];

    // 正常编辑产生的 marks 已经有序且不重叠。先走线性合并快路径；
    // 只有兼容旧数据中的重叠区间才回退到下面保留“后者覆盖前者”语义的切片算法。
    let ordered = true;
    for (let i = 1; i < marks.length; i++) {
      if (marks[i - 1].start > marks[i].start
        || (marks[i - 1].start === marks[i].start && marks[i - 1].end > marks[i].end)) {
        ordered = false;
        break;
      }
    }
    const orderedMarks = ordered ? marks : marks.slice().sort(function (a, b) {
      return a.start - b.start || a.end - b.end;
    });
    let overlaps = false;
    for (let i = 1; i < orderedMarks.length; i++) {
      if (orderedMarks[i].start < orderedMarks[i - 1].end) {
        overlaps = true;
        break;
      }
    }
    if (!overlaps) {
      const compact = [];
      orderedMarks.forEach(function (mark) {
        const last = compact[compact.length - 1];
        if (last && last.end === mark.start && sameStyle(last, mark)) last.end = mark.end;
        else compact.push(Object.assign({}, mark));
      });
      return compact;
    }

    const points = new Set([0, length]);
    marks.forEach(function (mark) { points.add(mark.start); points.add(mark.end); });
    const sorted = Array.from(points).sort(function (a, b) { return a - b; });
    const out = [];
    for (let i = 0; i < sorted.length - 1; i++) {
      const start = sorted[i];
      const end = sorted[i + 1];
      if (end <= start) continue;
      const style = styleAt(marks, start);
      if (!hasStyle(style)) continue;
      const last = out[out.length - 1];
      if (last && last.end === start && sameStyle(last, style)) {
        last.end = end;
      } else {
        out.push(Object.assign({ start: start, end: end }, style));
      }
    }
    return out;
  }

  function apply(text, rawMarks, start, end, patch) {
    text = String(text == null ? '' : text);
    start = Math.max(0, Math.min(text.length, Math.floor(Number(start)) || 0));
    end = Math.max(start, Math.min(text.length, Math.floor(Number(end)) || 0));
    const marks = normalize(text, rawMarks);
    if (end <= start) return marks;

    const points = new Set([0, text.length, start, end]);
    marks.forEach(function (mark) { points.add(mark.start); points.add(mark.end); });
    const sorted = Array.from(points).sort(function (a, b) { return a - b; });
    const out = [];
    for (let i = 0; i < sorted.length - 1; i++) {
      const a = sorted[i];
      const b = sorted[i + 1];
      if (b <= a) continue;
      const style = styleAtNormalized(marks, a);
      if (a >= start && b <= end) {
        if (patch && patch.clear === true) {
          STYLE_KEYS.forEach(function (key) { delete style[key]; });
        } else if (patch && typeof patch === 'object') {
          STYLE_KEYS.forEach(function (key) {
            if (!Object.prototype.hasOwnProperty.call(patch, key)) return;
            const value = patch[key];
            if (value == null || value === false || value === '') delete style[key];
            else style[key] = value;
          });
        }
      }
      if (!hasStyle(style)) continue;
      const last = out[out.length - 1];
      if (last && last.end === a && sameStyle(last, style)) last.end = b;
      else out.push(Object.assign({ start: a, end: b }, cleanStyle(style)));
    }
    return normalize(text, out);
  }

  function slice(text, rawMarks, start, end) {
    text = String(text == null ? '' : text);
    start = Math.max(0, Math.min(text.length, Math.floor(Number(start)) || 0));
    end = Math.max(start, Math.min(text.length, Math.floor(Number(end)) || 0));
    return normalize(text, rawMarks).filter(function (mark) {
      return mark.start < end && mark.end > start;
    }).map(function (mark) {
      return Object.assign({}, mark, {
        start: Math.max(mark.start, start) - start,
        end: Math.min(mark.end, end) - start,
      });
    });
  }

  function rangeStyle(text, rawMarks, start, end) {
    text = String(text == null ? '' : text);
    start = Math.max(0, Math.min(text.length, Math.floor(Number(start)) || 0));
    end = Math.max(start, Math.min(text.length, Math.floor(Number(end)) || 0));
    const marks = normalize(text, rawMarks);
    const result = {};
    const points = new Set([start, end]);
    marks.forEach(function (mark) {
      if (mark.start < end && mark.end > start) {
        points.add(Math.max(start, mark.start));
        points.add(Math.min(end, mark.end));
      }
    });
    const sorted = Array.from(points).sort(function (a, b) { return a - b; });
    STYLE_KEYS.forEach(function (key) {
      let first;
      let seen = false;
      let mixed = false;
      for (let i = 0; i < sorted.length - 1; i++) {
        if (sorted[i + 1] <= sorted[i]) continue;
        const value = styleAtNormalized(marks, sorted[i])[key] || null;
        if (!seen) { first = value; seen = true; }
        else if (first !== value) mixed = true;
      }
      result[key] = { value: mixed ? null : (first || null), mixed: mixed };
    });
    return result;
  }

  function appendRun(runs, text, style) {
    if (!text) return;
    style = cleanStyle(style);
    const last = runs[runs.length - 1];
    if (last && sameStyle(last.style, style)) last.text += text;
    else runs.push({ text: text, style: style });
  }

  function applyOuterStyle(runs, outer) {
    return runs.map(function (run) {
      // DOM/CSS 的嵌套语义是内层覆盖外层；兼容迁移时保持同一结果。
      return { text: run.text, style: Object.assign({}, cleanStyle(outer), cleanStyle(run.style)) };
    });
  }

  function matchingBrace(input, openIndex) {
    let depth = 0;
    for (let i = openIndex; i < input.length; i++) {
      if (input[i] === '{') depth += 1;
      else if (input[i] === '}') {
        depth -= 1;
        if (depth === 0) return i;
      }
    }
    return -1;
  }

  function parseLegacyInline(input) {
    const runs = [];
    let changed = false;
    let i = 0;
    while (i < input.length) {
      // 行内代码保持源码原样，里面类似 {hl:...} 的文字不是富文本命令。
      if (input[i] === '`') {
        const close = input.indexOf('`', i + 1);
        if (close > i) {
          appendRun(runs, input.slice(i, close + 1), {});
          i = close + 1;
          continue;
        }
      }

      const custom = input[i] === '{'
        ? /^\{(hl|tc|fs):(yellow|orange|red|purple|blue|cyan|green|gray|white|sm|lg|xl)\|/.exec(input.slice(i))
        : null;
      if (custom) {
        const valid = custom[1] === 'fs' ? SIZES.has(custom[2])
          : (custom[1] === 'hl' ? HIGHLIGHT_COLORS.has(custom[2]) : TEXT_COLORS.has(custom[2]));
        const close = valid ? matchingBrace(input, i) : -1;
        if (close > i + custom[0].length) {
          const inner = parseLegacyInline(input.slice(i + custom[0].length, close));
          const style = custom[1] === 'hl' ? { highlight: custom[2] }
            : custom[1] === 'tc' ? { color: custom[2] } : { size: custom[2] };
          applyOuterStyle(inner.runs, style).forEach(function (run) { appendRun(runs, run.text, run.style); });
          changed = true;
          i = close + 1;
          continue;
        }
      }

      if (input[i] === '*' && input[i + 1] === '*') {
        const close = input.indexOf('**', i + 2);
        if (close > i + 2) {
          const inner = parseLegacyInline(input.slice(i + 2, close));
          applyOuterStyle(inner.runs, { bold: true }).forEach(function (run) { appendRun(runs, run.text, run.style); });
          changed = true;
          i = close + 2;
          continue;
        }
      }

      if (input[i] === '=' && input[i + 1] === '=') {
        const close = input.indexOf('==', i + 2);
        if (close > i + 2) {
          const inner = parseLegacyInline(input.slice(i + 2, close));
          applyOuterStyle(inner.runs, { highlight: 'yellow' }).forEach(function (run) { appendRun(runs, run.text, run.style); });
          changed = true;
          i = close + 2;
          continue;
        }
      }

      appendRun(runs, input[i], {});
      i += 1;
    }
    return { runs: runs, changed: changed };
  }

  function parseLegacy(source) {
    source = String(source == null ? '' : source).replace(/\r\n?/g, '\n');
    const lines = source.split('\n');
    const runs = [];
    let changed = false;
    let fenced = false;
    lines.forEach(function (line, index) {
      if (/^\s*```/.test(line)) {
        appendRun(runs, line, {});
        fenced = !fenced;
      } else if (fenced) {
        appendRun(runs, line, {});
      } else {
        const parsed = parseLegacyInline(line);
        parsed.runs.forEach(function (run) { appendRun(runs, run.text, run.style); });
        changed = changed || parsed.changed;
      }
      if (index < lines.length - 1) appendRun(runs, '\n', {});
    });

    let text = '';
    const marks = [];
    runs.forEach(function (run) {
      const start = text.length;
      text += run.text;
      if (hasStyle(run.style) && run.text.length) {
        marks.push(Object.assign({ start: start, end: text.length }, cleanStyle(run.style)));
      }
    });
    return { text: text, marks: normalize(text, marks), changed: changed };
  }

  function wrapPiece(text, style) {
    if (!text) return text;
    let out = text;
    if (style.bold) out = '**' + out + '**';
    if (style.size) out = '{fs:' + style.size + '|' + out + '}';
    if (style.color) out = '{tc:' + style.color + '|' + out + '}';
    if (style.highlight) {
      out = style.highlight === 'yellow' ? '==' + out + '=='
        : '{hl:' + style.highlight + '|' + out + '}';
    }
    return out;
  }

  function wrapLines(text, style) {
    return String(text).split('\n').map(function (line) {
      return line ? wrapPiece(line, style) : '';
    }).join('\n');
  }

  function serialize(text, rawMarks) {
    text = String(text == null ? '' : text);
    const marks = normalize(text, rawMarks);
    if (!marks.length) return text;
    let out = '';
    let pos = 0;
    marks.forEach(function (mark) {
      if (mark.start > pos) out += text.slice(pos, mark.start);
      out += wrapLines(text.slice(mark.start, mark.end), mark);
      pos = mark.end;
    });
    if (pos < text.length) out += text.slice(pos);
    return out;
  }

  function renderEditable(root, text, rawMarks) {
    if (!root || !global.document) return;
    text = String(text == null ? '' : text);
    const marks = normalize(text, rawMarks);
    const fragment = global.document.createDocumentFragment();
    let pos = 0;
    function appendText(value, style) {
      if (!value) return;
      if (!hasStyle(style)) {
        fragment.appendChild(global.document.createTextNode(value));
        return;
      }
      const span = global.document.createElement('span');
      span.className = 'rt-run';
      if (style.size) span.dataset.rtSize = style.size;
      if (style.color) span.dataset.rtColor = style.color;
      if (style.highlight) span.dataset.rtHighlight = style.highlight;
      if (style.bold) span.dataset.rtBold = '1';
      span.textContent = value;
      fragment.appendChild(span);
    }
    marks.forEach(function (mark) {
      if (mark.start > pos) appendText(text.slice(pos, mark.start), {});
      appendText(text.slice(mark.start, mark.end), mark);
      pos = mark.end;
    });
    if (pos < text.length) appendText(text.slice(pos), {});
    root.replaceChildren(fragment);
    if (!text) root.appendChild(global.document.createTextNode(''));
  }

  function styleFromAncestors(node, root) {
    const style = {};
    let el = node && node.parentElement;
    while (el && el !== root) {
      if (el.dataset) {
        if (!style.size && SIZES.has(el.dataset.rtSize)) style.size = el.dataset.rtSize;
        if (!style.color && TEXT_COLORS.has(el.dataset.rtColor)) style.color = el.dataset.rtColor;
        if (!style.highlight && HIGHLIGHT_COLORS.has(el.dataset.rtHighlight)) style.highlight = el.dataset.rtHighlight;
        if (!style.bold && el.dataset.rtBold === '1') style.bold = true;
      }
      el = el.parentElement;
    }
    return style;
  }

  function readEditable(root, point) {
    let text = '';
    let atLineBreak = false;
    const marks = [];
    let pointOffset = null;
    const normalizeBreaks = value => value.replace(/\r\n?/g, '\n');
    function recordPoint(container, offset) {
      if (point && point.container === container && point.offset === offset) pointOffset = text.length;
    }
    function append(value) {
      if (!value) return;
      text += value;
      atLineBreak = value.endsWith('\n');
    }

    // Chromium uses DIV/P siblings for lines and a trailing BR as a caret placeholder.
    // Counting both as authored line breaks would double each blank block in innerText.
    function visit(parent, endsBeforeSibling) {
      const children = parent.childNodes;
      let hasPrevious = false;
      let previousBlock = false;
      for (let index = 0; index < children.length; index++) {
        const child = children[index];
        recordPoint(parent, index);
        if (pointOffset !== null) return;
        if ((child.nodeType !== 3 && child.nodeType !== 1) || child.hidden || child.style?.display === 'none') continue;
        const finalChild = index === children.length - 1;
        const block = child.nodeName === 'DIV' || child.nodeName === 'P';
        if (block && !child.childNodes.length) continue;
        if (child.nodeType === 3 && !child.nodeValue) continue;
        if (hasPrevious && (previousBlock || (block && !atLineBreak))) append('\n');
        if (child.nodeType === 3) {
          let value = normalizeBreaks(child.nodeValue);
          if (finalChild && endsBeforeSibling && value.endsWith('\n')) value = value.slice(0, -1);
          if (point?.container === child) {
            pointOffset = text.length + Math.min(value.length, normalizeBreaks(child.nodeValue.slice(0, point.offset)).length);
            return;
          }
          const start = text.length;
          append(value);
          if (!point && value) {
            const style = styleFromAncestors(child, root);
            if (hasStyle(style)) marks.push(Object.assign({ start: start, end: text.length }, style));
          }
        } else if (child.nodeName === 'BR') {
          recordPoint(child, 0);
          if (!finalChild) append('\n');
        } else {
          visit(child, block ? !finalChild : (finalChild && endsBeforeSibling));
        }
        if (pointOffset !== null) return;
        hasPrevious = true;
        previousBlock = block;
      }
      recordPoint(parent, children.length);
    }
    if (root) visit(root, false);
    if (point) return pointOffset;
    return { text: text, marks: normalize(text, marks) };
  }

  function extractEditable(root) {
    return readEditable(root);
  }

  function editableOffset(root, container, offset) {
    return readEditable(root, { container: container, offset: offset });
  }

  function concat(parts) {
    let text = '';
    const marks = [];
    (Array.isArray(parts) ? parts : []).forEach(function (part) {
      const value = String(part && part.text != null ? part.text : '');
      const offset = text.length;
      normalize(value, part && part.marks).forEach(function (mark) {
        marks.push(Object.assign({}, mark, { start: mark.start + offset, end: mark.end + offset }));
      });
      text += value;
    });
    return { text: text, marks: normalize(text, marks) };
  }

  global.RelatumRichText = {
    COLORS: Array.from(TEXT_COLORS),
    HIGHLIGHTS: Array.from(HIGHLIGHT_COLORS),
    SIZES: Array.from(SIZES),
    normalize: normalize,
    apply: apply,
    slice: slice,
    rangeStyle: rangeStyle,
    parseLegacy: parseLegacy,
    serialize: serialize,
    renderEditable: renderEditable,
    extractEditable: extractEditable,
    editableOffset: editableOffset,
    concat: concat,
  };
})(typeof window !== 'undefined' ? window : globalThis);
